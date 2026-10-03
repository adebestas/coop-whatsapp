import { createHash } from "node:crypto";
import { prisma, withTx } from "../lib/prisma.js";

export interface AuditEntry {
  cooperativeId: string;
  actorPhone: string;
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  amount?: number; // transaction amount in kobo
  balanceBefore?: number; // wallet balance before in kobo
  balanceAfter?: number; // wallet balance after in kobo
  detail?: string;
}

function hashEntry(prevHash: string | null, payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${prevHash ?? "GENESIS"}|${JSON.stringify(payload)}`)
    .digest("hex");
}

function isPostgres(): boolean {
  return (process.env.DATABASE_URL ?? "").startsWith("postgres");
}

/**
 * In-process per-cooperative mutex. SQLite has no advisory locks, so this is
 * what serializes the read-previous-hash + insert there. The tail is kept
 * settled so a rejected write cannot poison the chain for later callers.
 */
const auditMutex = new Map<string, Promise<unknown>>();

function withAuditMutex<T>(coopId: string, fn: () => Promise<T>): Promise<T> {
  const prev = auditMutex.get(coopId) ?? Promise.resolve();
  const run = prev.then(() => fn());
  auditMutex.set(
    coopId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Serialize audit writes for one cooperative so the read-previous-hash + insert
 * is atomic. Postgres uses a transaction-scoped advisory lock (correct across
 * multiple instances); SQLite uses the in-process mutex.
 */
function withAuditSerialization<T>(coopId: string, fn: () => Promise<T>): Promise<T> {
  if (isPostgres()) {
    return withTx(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${coopId}))`;
      return fn();
    });
  }
  return withAuditMutex(coopId, fn);
}

/**
 * Append-only, hash-chained trail of every money/admin action. Each entry
 * carries the hash of the previous one — editing history breaks the chain
 * (checked nightly by the reconciliation job). Never throws.
 *
 * Writes are serialized per cooperative and ordered by a monotonic `seq`, so
 * concurrent writes cannot fork the chain and verification is deterministic.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await withAuditSerialization(entry.cooperativeId, async () => {
      const last = await prisma.auditLog.findFirst({
        where: { cooperativeId: entry.cooperativeId },
        orderBy: { seq: "desc" },
        select: { hash: true, seq: true },
      });
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = last?.hash ?? null;
      const payload = {
        actorId: entry.actorId ?? null,
        actorPhone: entry.actorPhone,
        actorRole: entry.actorRole ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        amount: entry.amount ?? null,
        balanceBefore: entry.balanceBefore ?? null,
        balanceAfter: entry.balanceAfter ?? null,
        detail: entry.detail?.slice(0, 500) ?? null,
      };
      await prisma.auditLog.create({
        data: {
          ...payload,
          cooperativeId: entry.cooperativeId,
          detail: entry.detail?.slice(0, 500),
          prevHash,
          hash: hashEntry(prevHash, payload),
          seq,
        },
      });
    });
  } catch (err) {
    console.error("[audit] failed to record", entry.action, err);
  }
}

/** Recent audit entries for a cooperative (admin visibility). */
export async function recentAudit(cooperativeId: string, take = 15) {
  return prisma.auditLog.findMany({
    where: { cooperativeId },
    orderBy: { seq: "desc" },
    take,
  });
}

/** Verify the hash chain; returns the first broken point, if any. */
export async function verifyAuditChain(cooperativeId: string) {
  const entries = await prisma.auditLog.findMany({
    where: { cooperativeId },
    orderBy: { seq: "asc" },
  });
  let prevHash: string | null = null;
  for (const e of entries) {
    const payload = {
      actorId: e.actorId,
      actorPhone: e.actorPhone,
      actorRole: e.actorRole,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      amount: e.amount,
      balanceBefore: e.balanceBefore,
      balanceAfter: e.balanceAfter,
      detail: e.detail,
    };
    if (e.hash !== hashEntry(e.prevHash, payload) || e.prevHash !== prevHash) {
      return { ok: false as const, brokenAt: e.id };
    }
    prevHash = e.hash;
  }
  return { ok: true as const, checked: entries.length };
}
