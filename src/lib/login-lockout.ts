import { prisma } from "./prisma.js";

export type LoginSurface = "dashboard_admin" | "dashboard_developer";
export type LoginOutcome = "success" | "bad_credentials" | "totp_failed" | "locked" | "unlocked";

export const ACCOUNT_FAILURE_LIMIT = 5;
export const ACCOUNT_WINDOW_MS = 15 * 60_000;
export const BASE_LOCK_MS = 15 * 60_000;
export const MAX_LOCK_MS = 8 * 60 * 60_000;
export const IP_FAILURE_LIMIT = 30;
export const IP_WINDOW_MS = 15 * 60_000;
export const IP_LOCK_MS = 60 * 60_000;
/** Locks older than this stop contributing to the doubling ladder. */
export const STRIKE_DECAY_MS = 24 * 60 * 60_000;

export interface LockStatus {
  locked: boolean;
  subject: "account" | "ip" | null;
  retryAfter: number;
}

const FREE: LockStatus = { locked: false, subject: null, retryAfter: 0 };

export interface AttemptInput {
  surface: LoginSurface;
  phone?: string | null;
  ip: string;
  memberId?: string | null;
  outcome: LoginOutcome;
  errorId?: string | null;
}

/** Append-only ledger write; used for every login outcome including locks. */
export async function recordLoginAttempt(input: AttemptInput): Promise<void> {
  await prisma.loginAttempt.create({
    data: {
      surface: input.surface,
      phone: input.phone ?? null,
      ip: input.ip,
      memberId: input.memberId ?? null,
      outcome: input.outcome,
      errorId: input.errorId ?? null,
    },
  });
}

function retrySeconds(until: Date, now: number): number {
  return Math.max(1, Math.ceil((until.getTime() - now) / 1000));
}

async function readLock(surface: LoginSurface, subject: string) {
  return prisma.loginLock.findUnique({
    where: { surface_subject: { surface, subject } },
  });
}

/** Cheap pre-check: is this account or IP currently locked? */
export async function lockStatus(
  surface: LoginSurface,
  ids: { phone?: string | null; ip: string },
): Promise<LockStatus> {
  const now = Date.now();
  if (ids.phone) {
    const row = await readLock(surface, ids.phone);
    if (row?.lockedUntil && row.lockedUntil.getTime() > now) {
      return { locked: true, subject: "account", retryAfter: retrySeconds(row.lockedUntil, now) };
    }
  }
  const ipRow = await readLock(surface, `ip:${ids.ip}`);
  if (ipRow?.lockedUntil && ipRow.lockedUntil.getTime() > now) {
    return { locked: true, subject: "ip", retryAfter: retrySeconds(ipRow.lockedUntil, now) };
  }
  return FREE;
}

async function bumpLock(
  surface: LoginSurface,
  subject: string,
  limit: number,
  windowMs: number,
  baseMs: number,
  maxMs: number,
  doubling: boolean,
): Promise<Date | null> {
  const now = new Date();
  const existing = await readLock(surface, subject);
  const expiresAt = existing?.lockedUntil && existing.lockedUntil.getTime() > now.getTime();
  if (expiresAt) return existing!.lockedUntil;

  const frozen = existing?.lockedUntil ?? null;
  const freshStrike = !existing || now.getTime() - existing.lastStrikeAt.getTime() > windowMs;
  const strikes = (freshStrike ? 0 : existing.strikes) + 1;

  if (strikes < limit) {
    await prisma.loginLock.upsert({
      where: { surface_subject: { surface, subject } },
      create: { surface, subject, strikes, lastStrikeAt: now, lockedUntil: frozen },
      update: { strikes, lastStrikeAt: now },
    });
    return null;
  }

  const priorLocks =
    existing && now.getTime() - existing.lastStrikeAt.getTime() <= STRIKE_DECAY_MS
      ? existing.lockCount
      : 0;
  const duration = doubling ? Math.min(baseMs * 2 ** priorLocks, maxMs) : Math.min(baseMs, maxMs);
  const lockedUntil = new Date(now.getTime() + duration);

  await prisma.loginLock.upsert({
    where: { surface_subject: { surface, subject } },
    create: {
      surface,
      subject,
      strikes: 0,
      lockCount: priorLocks + 1,
      lockedUntil,
      lastStrikeAt: now,
    },
    update: { strikes: 0, lockCount: priorLocks + 1, lockedUntil, lastStrikeAt: now },
  });
  return lockedUntil;
}

/**
 * Record a failed attempt and apply the lockout ladder.
 * Account: 5 failures / 15 min -> 15 min, doubling per lock within 24 h, cap 8 h.
 * IP: 30 failures / 15 min -> flat 1 h.
 */
import { alertLockout } from "./anomaly-rules.js";

export async function registerFailure(input: AttemptInput): Promise<LockStatus> {
  await recordLoginAttempt(input);
  const now = Date.now();

  if (input.phone) {
    const until = await bumpLock(
      input.surface,
      input.phone,
      ACCOUNT_FAILURE_LIMIT,
      ACCOUNT_WINDOW_MS,
      BASE_LOCK_MS,
      MAX_LOCK_MS,
      true,
    );
    if (until) {
      await recordLoginAttempt({ ...input, outcome: "locked" });
      void alertLockout(input.surface, input.phone, input.ip).catch(() => undefined);
      return { locked: true, subject: "account", retryAfter: retrySeconds(until, now) };
    }
  }

  const ipUntil = await bumpLock(
    input.surface,
    `ip:${input.ip}`,
    IP_FAILURE_LIMIT,
    IP_WINDOW_MS,
    IP_LOCK_MS,
    IP_LOCK_MS,
    false,
  );
  if (ipUntil) {
    await recordLoginAttempt({ ...input, outcome: "locked" });
    void alertLockout(input.surface, `ip:${input.ip}`, input.ip).catch(() => undefined);
    return { locked: true, subject: "ip", retryAfter: retrySeconds(ipUntil, now) };
  }
  return FREE;
}

/** Successful login clears the failure window but keeps the 24 h lock history. */
export async function clearFailures(
  surface: LoginSurface,
  ids: { phone?: string | null; ip: string },
): Promise<void> {
  const now = new Date();
  const subjects = [`ip:${ids.ip}`, ...(ids.phone ? [ids.phone] : [])];
  await prisma.loginLock.updateMany({
    where: { surface, subject: { in: subjects }, lockedUntil: null },
    data: { strikes: 0 },
  });
  await recordLoginAttempt({
    surface,
    phone: ids.phone ?? null,
    ip: ids.ip,
    outcome: "success",
  });
  void now;
}

/** Superadmin unlock: clears the account lock and its failure window. */
export async function unlockAccount(
  surface: LoginSurface,
  phone: string,
  ip: string,
  actorId: string,
): Promise<number> {
  const row = await readLock(surface, phone);
  const cleared = row?.lockedUntil
    ? Math.max(0, Math.ceil((row.lockedUntil.getTime() - Date.now()) / 1000))
    : 0;
  await prisma.loginLock.updateMany({
    where: { surface, subject: phone },
    data: { strikes: 0, lockCount: 0, lockedUntil: null, lastStrikeAt: new Date() },
  });
  await recordLoginAttempt({
    surface,
    phone,
    ip,
    outcome: "unlocked",
    errorId: `by:${actorId}`,
  });
  return cleared;
}
