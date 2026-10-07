import { randomUUID } from "node:crypto";
import { prisma, withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import { audit } from "./audit.js";
import { formatBalance } from "../lib/money.js";
import { resolveProvider, markProviderUp, markProviderDown } from "./payments/index.js";

export interface MandateActor {
  id: string;
  phone: string;
  role?: string | null;
}

export interface MandateSummary {
  id: string;
  memberId: string;
  provider: string;
  status: string;
  amountCap: number;
  bankAccountNumber: string;
  bankCode: string;
  bankName: string | null;
  purposes: string;
  pausedPurposes: string;
  authorizationUrl: string | null;
  createdAt: Date;
  authorizedAt: Date | null;
  cancelledAt: Date | null;
  lastDebitAt: Date | null;
}

function toSummary(m: {
  id: string;
  memberId: string;
  provider: string;
  status: string;
  amountCap: number;
  bankAccountNumber: string;
  bankCode: string;
  bankName: string | null;
  purposes: string;
  pausedPurposes: string;
  authorizationUrl: string | null;
  createdAt: Date;
  authorizedAt: Date | null;
  cancelledAt: Date | null;
  lastDebitAt: Date | null;
}): MandateSummary {
  return { ...m };
}

/** Split a CSV column into a de-duplicated, order-preserving list. */
function csvSet(value: string): string[] {
  return [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];
}

/**
 * Start a direct-debit mandate for a member. Validates that direct debit is
 * enabled for the cooperative, the member has a saved bank account, and the cap
 * is within the cooperative's ceiling, then asks the provider for a consent
 * link and persists a `pending` mandate. Audited.
 */
export async function createMandate(
  coopId: string,
  memberId: string,
  cap: number,
  actor: MandateActor,
): Promise<{ ok: boolean; message: string; mandateId?: string; authorizationUrl?: string }> {
  const config = await prisma.cooperativeConfig.findUnique({ where: { cooperativeId: coopId } });
  if (!config?.directDebitEnabled) {
    return { ok: false, message: "Direct debit is not enabled for your cooperative." };
  }

  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) return { ok: false, message: "Member not found." };
  if (!member.bankAccountNumber || !member.bankCode) {
    return {
      ok: false,
      message: "Please add a bank account first. Reply *withdraw* to save one, then try again.",
    };
  }

  if (!Number.isInteger(cap) || cap <= 0) {
    return { ok: false, message: "Enter a positive debit cap, e.g. *mandate 5000*." };
  }
  if (config.directDebitMaxCap > 0 && cap > config.directDebitMaxCap) {
    return {
      ok: false,
      message: `Your cooperative caps direct debit at *${formatBalance(config.directDebitMaxCap)}* per debit.`,
    };
  }

  const provider = await resolveProvider();
  const providerReference = `MAN-${randomUUID()}`;
  const result = await provider.createMandate?.({
    memberName: member.name,
    memberEmail: member.email ?? `${member.phone}@coop.local`,
    memberPhone: member.phone,
    accountNumber: member.bankAccountNumber,
    bankCode: member.bankCode,
    accountName: member.name,
    amountCap: cap,
    reference: providerReference,
    narration: "Cooperative savings/loan mandate",
  });

  if (!result?.ok) {
    try {
      await markProviderDown(provider.name);
    } catch {
      /* circuit-breaker bookkeeping is best-effort */
    }
    return {
      ok: false,
      message: result?.error ?? "We couldn't start the mandate right now. Please try again.",
    };
  }
  try {
    await markProviderUp(provider.name);
  } catch {
    /* circuit-breaker bookkeeping is best-effort */
  }

  const mandate = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    return tx.mandate.create({
      data: {
        cooperativeId: coopId,
        memberId,
        provider: provider.name,
        providerMandateId: result.providerMandateId ?? null,
        providerReference,
        status: "pending",
        amountCap: cap,
        bankAccountNumber: member.bankAccountNumber as string,
        bankCode: member.bankCode as string,
        bankName: member.bankName,
        accountName: member.name,
        authorizationUrl: result.authorizationUrl ?? null,
      },
    });
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role ?? null,
    action: "mandate.create",
    targetType: "mandate",
    targetId: mandate.id,
    amount: cap,
    detail: `${provider.name} cap ${formatBalance(cap)}`,
  }).catch(() => {});

  const linkLine = result.authorizationUrl
    ? `\n\nAuthorize it here:\n${result.authorizationUrl}`
    : "\n\nThe provider will send you an authorization link shortly.";
  return {
    ok: true,
    message:
      `✅ Direct-debit mandate started. Cap: *${formatBalance(cap)}* per debit.${linkLine}\n\n` +
      `Mandate ID: *${mandate.id}*`,
    mandateId: mandate.id,
    authorizationUrl: result.authorizationUrl,
  };
}

/** A member's mandates in a cooperative. */
export async function listMandates(
  coopId: string,
  memberId: string,
): Promise<{ ok: boolean; message: string; mandates?: MandateSummary[] }> {
  const rows = await prisma.mandate.findMany({
    where: { cooperativeId: coopId, memberId },
    orderBy: { createdAt: "desc" },
  });
  return {
    ok: true,
    message: rows.length ? `${rows.length} mandate(s).` : "You have no direct-debit mandates yet.",
    mandates: rows.map(toSummary),
  };
}

/** Every mandate in a cooperative (admin visibility). */
export async function listCoopMandates(
  coopId: string,
): Promise<{ ok: boolean; message: string; mandates?: MandateSummary[] }> {
  const rows = await prisma.mandate.findMany({
    where: { cooperativeId: coopId },
    orderBy: { createdAt: "desc" },
  });
  return {
    ok: true,
    message: rows.length ? `${rows.length} mandate(s).` : "No direct-debit mandates yet.",
    mandates: rows.map(toSummary),
  };
}

/**
 * Cancel a member's mandate: ask the provider to cancel it first (when it has a
 * provider id), then mark it `cancelled`. Audited.
 */
export async function cancelMandate(
  coopId: string,
  mandateId: string,
  actor: MandateActor,
): Promise<{ ok: boolean; message: string }> {
  if (!mandateId) return { ok: false, message: "Mandate not found." };
  const mandate = await prisma.mandate.findFirst({
    where: {
      cooperativeId: coopId,
      memberId: actor.id,
      OR: [
        { id: mandateId },
        { id: { startsWith: mandateId } },
        { id: { endsWith: mandateId } },
      ],
    },
  });
  if (!mandate) return { ok: false, message: "Mandate not found." };
  if (mandate.status === "cancelled") {
    return { ok: false, message: "This mandate is already cancelled." };
  }

  if (mandate.providerMandateId) {
    const provider = await resolveProvider(mandate.provider);
    const cancelled = await provider.cancelMandate?.({
      providerMandateId: mandate.providerMandateId,
    });
    if (cancelled && !cancelled.ok) {
      return {
        ok: false,
        message: cancelled.error ?? "The provider could not cancel this mandate. Please try again.",
      };
    }
  }

  await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    await tx.mandate.update({
      where: { id: mandate.id },
      data: { status: "cancelled", cancelledAt: new Date() },
    });
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role ?? null,
    action: "mandate.cancel",
    targetType: "mandate",
    targetId: mandate.id,
  }).catch(() => {});

  return { ok: true, message: "✅ Mandate cancelled. No further debits will be collected." };
}

/** Flip a mandate's status from a provider webhook; stamp `authorizedAt` on activation. */
export async function applyMandateStatus(
  provider: string,
  providerMandateId: string,
  status: string,
): Promise<void> {
  await prisma.mandate.updateMany({
    where: { provider, providerMandateId },
    data: {
      status,
      ...(status === "active" ? { authorizedAt: new Date() } : {}),
    },
  });
}

/**
 * Pause a mandate. `purpose === null` pauses the WHOLE mandate (`status` →
 * `paused`); a purpose pauses just that purpose by adding it to `pausedPurposes`.
 */
export async function pauseMandate(
  coopId: string,
  mandateId: string,
  purpose: string | null,
  actor: MandateActor,
): Promise<{ ok: boolean; message: string }> {
  const mandate = await prisma.mandate.findFirst({
    where: { id: mandateId, cooperativeId: coopId },
  });
  if (!mandate) return { ok: false, message: "Mandate not found." };

  if (purpose === null) {
    if (mandate.status !== "active" && mandate.status !== "paused") {
      return { ok: false, message: "Only an active mandate can be paused." };
    }
    await withTx(async (tx) => {
      await setCoopContext(tx as never, coopId);
      await tx.mandate.update({ where: { id: mandate.id }, data: { status: "paused" } });
    });
    await audit({
      cooperativeId: coopId,
      actorPhone: actor.phone,
      actorId: actor.id,
      actorRole: actor.role ?? null,
      action: "mandate.pause",
      targetType: "mandate",
      targetId: mandate.id,
      detail: "whole mandate",
    }).catch(() => {});
    return { ok: true, message: "⏸️ Mandate paused. No debits will be collected until you resume." };
  }

  const paused = csvSet(mandate.pausedPurposes);
  if (!paused.includes(purpose)) paused.push(purpose);
  await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    await tx.mandate.update({
      where: { id: mandate.id },
      data: { pausedPurposes: paused.join(",") },
    });
  });
  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role ?? null,
    action: "mandate.pause",
    targetType: "mandate",
    targetId: mandate.id,
    detail: purpose,
  }).catch(() => {});
  return { ok: true, message: `⏸️ Direct debits for *${purpose}* are paused.` };
}

/**
 * Resume a mandate. `purpose === null` resumes the WHOLE mandate (`status` →
 * `active`); a purpose removes it from `pausedPurposes`.
 */
export async function resumeMandate(
  coopId: string,
  mandateId: string,
  purpose: string | null,
  actor: MandateActor,
): Promise<{ ok: boolean; message: string }> {
  const mandate = await prisma.mandate.findFirst({
    where: { id: mandateId, cooperativeId: coopId },
  });
  if (!mandate) return { ok: false, message: "Mandate not found." };

  if (purpose === null) {
    if (mandate.status === "cancelled" || mandate.status === "expired") {
      return { ok: false, message: `This mandate is ${mandate.status} and cannot be resumed.` };
    }
    await withTx(async (tx) => {
      await setCoopContext(tx as never, coopId);
      await tx.mandate.update({ where: { id: mandate.id }, data: { status: "active" } });
    });
    await audit({
      cooperativeId: coopId,
      actorPhone: actor.phone,
      actorId: actor.id,
      actorRole: actor.role ?? null,
      action: "mandate.resume",
      targetType: "mandate",
      targetId: mandate.id,
      detail: "whole mandate",
    }).catch(() => {});
    return { ok: true, message: "▶️ Mandate resumed. Debits will resume as obligations fall due." };
  }

  const paused = csvSet(mandate.pausedPurposes).filter((p) => p !== purpose);
  await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    await tx.mandate.update({
      where: { id: mandate.id },
      data: { pausedPurposes: paused.join(",") },
    });
  });
  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role ?? null,
    action: "mandate.resume",
    targetType: "mandate",
    targetId: mandate.id,
    detail: purpose,
  }).catch(() => {});
  return { ok: true, message: `▶️ Direct debits for *${purpose}* are resumed.` };
}

/** Mark a single pending debit `skipped` so the retry job never picks it up. */
export async function skipDebit(
  coopId: string,
  debitId: string,
  actor: MandateActor,
): Promise<{ ok: boolean; message: string }> {
  const debit = await prisma.mandateDebit.findFirst({
    where: { id: debitId, cooperativeId: coopId },
  });
  if (!debit) return { ok: false, message: "Debit not found." };
  if (debit.status !== "pending") {
    return { ok: false, message: "Only a pending debit can be skipped." };
  }

  await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    await tx.mandateDebit.update({ where: { id: debit.id }, data: { status: "skipped" } });
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role ?? null,
    action: "mandate.debit_skip",
    targetType: "mandate_debit",
    targetId: debit.id,
    amount: debit.amount,
    detail: debit.purpose,
  }).catch(() => {});

  return { ok: true, message: "✅ Debit skipped. It will not be retried." };
}
