import { randomUUID } from "node:crypto";
import { prisma, withTx } from "../lib/prisma.js";
import {
  setCoopContext,
  withCoopContext,
  resolveCoopByMandateDebitRef,
  resolveCoopByMandateProviderId,
} from "../lib/tenant-context.js";
import { audit } from "./audit.js";
import { formatBalance } from "../lib/money.js";
import { postJournal } from "./journal.js";
import { notifyMember } from "../lib/messaging.js";
import { alertSupers, AlertSeverity } from "../lib/alerting.js";
import { log } from "../lib/logger.js";
import { resolveProvider, markProviderUp, markProviderDown } from "./payments/index.js";
import { repayLoan } from "./loans.js";
import { contributeToGroup } from "./groups.js";

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
  bank?: {
    accountNumber: string;
    bankCode: string;
    bankName?: string | null;
    accountName?: string | null;
  },
): Promise<{ ok: boolean; message: string; mandateId?: string; authorizationUrl?: string }> {
  const config = await prisma.cooperativeConfig.findUnique({ where: { cooperativeId: coopId } });
  if (!config?.directDebitEnabled) {
    return { ok: false, message: "Direct debit is not enabled for your cooperative." };
  }

  const member = await prisma.member.findUnique({ where: { id: memberId } });
  if (!member) return { ok: false, message: "Member not found." };
  // The account confirmed in the guided flow wins; otherwise fall back to the
  // member's saved bank account (used by direct/programmatic callers).
  const accountNumber = bank?.accountNumber ?? member.bankAccountNumber;
  const bankCode = bank?.bankCode ?? member.bankCode;
  const bankName = bank?.bankName ?? member.bankName;
  const accountName = bank?.accountName ?? member.name;
  if (!accountNumber || !bankCode) {
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

  // One flexible mandate per member: never let a second mandate double-charge
  // the same obligation.
  const existing = await prisma.mandate.findFirst({
    where: { cooperativeId: coopId, memberId, status: { in: ["pending", "active"] } },
  });
  if (existing) {
    return {
      ok: false,
      message:
        "You already have a direct-debit mandate. Reply *mandates* to see it, or cancel it before starting another.",
    };
  }

  const provider = await resolveProvider();

  // Paystack direct debit is feature-gated fail-closed. Its activation webhook
  // yields an `authorization_code`, but its initialize response only gives a
  // `reference`, so a created Paystack mandate could never activate — and the
  // debit path would then mis-key (the reference is not a valid
  // authorization_code), risking a double charge. Refuse until the contract is
  // verified end-to-end against live Paystack.
  if (provider.name === "paystack") {
    return {
      ok: false,
      message: "Paystack direct debit is not yet enabled. Please use Monnify or try again later.",
    };
  }

  const providerReference = `MAN-${randomUUID()}`;
  const result = await provider.createMandate?.({
    memberName: member.name,
    memberEmail: member.email ?? `${member.phone}@coop.local`,
    memberPhone: member.phone,
    accountNumber,
    bankCode,
    accountName,
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
        bankAccountNumber: accountNumber,
        bankCode,
        bankName,
        accountName,
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
    detail: `${provider.name} cap ${formatBalance(cap)} • ${bankName ?? bankCode} ****${accountNumber.slice(-4)}`,
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
    take: 50,
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
  // A webhook has no coop context, so resolve the owning tenant FIRST via the
  // SECURITY DEFINER resolver (bypasses RLS). Unknown/ambiguous -> nothing to
  // do (fail-closed). Without this the update matched zero rows under enforced
  // RLS and the mandate silently stayed `pending` while the event was acked.
  const coopId = await resolveCoopByMandateProviderId(providerMandateId);
  if (!coopId) return;

  await withCoopContext(coopId, async () => {
    await prisma.mandate.updateMany({
      where: { provider, providerMandateId },
      data: {
        status,
        ...(status === "active" ? { authorizedAt: new Date() } : {}),
      },
    });
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

/** Load the fields notifyMember needs, tolerating a missing member. */
async function loadNotifiable(memberId: string) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { phone: true, optedOut: true, preferredChannel: true, altChannelId: true },
  });
  return member ?? { phone: "", optedOut: false, preferredChannel: null, altChannelId: null };
}

/**
 * Apply a settled debit to the obligation it was collected for. `savings` is a
 * no-op — the wallet credit IS the savings deposit. `loan` repays the target
 * loan from the just-credited wallet; `group` contributes to the target group
 * from the just-credited wallet.
 */
async function applyPurpose(
  debit: { purpose: string; targetId: string | null; cooperativeId: string; amount: number },
  member: { id: string; phone: string },
): Promise<void> {
  switch (debit.purpose) {
    case "savings":
      // The wallet credit IS the savings deposit (settleDebit already credited
      // it), but the member is still notified after every debit (success or
      // failure) — there is no pre-debit notice.
      await notifyMember(
        await loadNotifiable(member.id),
        `✅ Savings contribution of *${formatBalance(debit.amount)}* collected from your bank.`,
      ).catch(() => {});
      return;
    case "loan": {
      const result = await repayLoan(
        member.phone,
        debit.targetId ?? undefined,
        debit.cooperativeId,
      );
      await notifyMember(await loadNotifiable(member.id), result.message).catch(() => {});
      // Surface a failed repayment to the caller so it can alert super admins —
      // the bank pull already succeeded, so silence here would strand the money.
      if (!result.ok) {
        throw new Error(`loan repayment failed: ${result.message}`);
      }
      return;
    }
    case "group": {
      // The wallet was just credited by settleDebit; contributeToGroup moves it
      // into the group pot. A failure here leaves the money on the wallet, so
      // surface it (the caller alerts) rather than swallow it.
      const result = await contributeToGroup(
        debit.cooperativeId,
        debit.targetId!,
        member.id,
        debit.amount,
      );
      await notifyMember(await loadNotifiable(member.id), result.message).catch(() => {});
      if (!result.ok) {
        throw new Error(`group contribution failed: ${result.message}`);
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Settle a mandate debit from a provider webhook. Idempotent. A `successful`
 * webhook settles a `pending` OR `failed` row (a debit the reconciler aged out
 * before the provider's delayed settlement arrived was still collected, so it
 * must be credited exactly once; a row already `successful` is a no-op). A
 * `failed` webhook only acts on a `pending` row. On success the wallet is
 * credited through the SAME balanced journal as a bank-transfer top-up, then
 * the debit's purpose is applied; on failure a retry is scheduled for +1 day.
 * Every movement carries a human-readable description. Never throws for an
 * unknown/terminal reference.
 */
export async function settleDebit(
  provider: string,
  reference: string,
  status: "successful" | "failed",
  providerTransactionId?: string,
  reason?: string,
): Promise<void> {
  // Resolve the owning cooperative FIRST (SECURITY DEFINER resolver bypasses
  // RLS), so the MandateDebit read below runs inside the tenant's RLS context.
  const coopId = await resolveCoopByMandateDebitRef(reference);
  if (!coopId) return; // unknown reference — nothing to settle (idempotent)

  const outcome = await withCoopContext(
    coopId,
    async (): Promise<"ok" | "ignored" | "no-wallet"> => {
      const debit = await prisma.mandateDebit.findUnique({ where: { providerRef: reference } });
      if (!debit) return "ignored";

      if (status === "failed") {
        // A failure only moves a still-pending debit; a failed or successful
        // row is terminal for this transition (idempotent).
        if (debit.status !== "pending") return "ignored";
        await prisma.mandateDebit.update({
          where: { id: debit.id },
          data: {
            status: "failed",
            failureReason: reason ?? "debit failed",
            nextRetryAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
        await notifyMember(
          await loadNotifiable(debit.memberId),
          `⚠️ We couldn't collect *${formatBalance(debit.amount)}* from your bank today. We'll try again tomorrow.`,
        ).catch(() => {});
        return "ok";
      }

      // Success may arrive LATE: the reconciler can have aged a still-pending
      // debit to `failed` before the provider's settlement webhook landed. Such
      // a row was collected, so credit it. Already-successful / skipped rows
      // are terminal no-ops.
      if (debit.status !== "pending" && debit.status !== "failed") return "ignored";

      const member = await prisma.member.findUnique({
        where: { id: debit.memberId },
        include: { wallet: true },
      });
      // A pending debit we cannot credit must NOT be silently acked (that would
      // strand it): report "no-wallet" so the caller alerts and retries.
      if (!member?.wallet) return "no-wallet";

      const description = `Direct debit — ${debit.purpose} via ${provider} (${formatBalance(debit.amount)})`;
      await withTx(async (tx) => {
        await postJournal(
          {
            cooperativeId: debit.cooperativeId,
            txRef: `DD-${reference}`,
            description,
            postings: [
              { account: "assets:bank", direction: "DEBIT", amount: debit.amount },
              {
                account: `member_wallet:${member.wallet!.id}`,
                direction: "CREDIT",
                amount: debit.amount,
                memberId: member.id,
              },
            ],
            throwOnDuplicate: true,
          },
          tx as never,
        );
        await tx.wallet.update({
          where: { id: member.wallet!.id },
          data: {
            balance: { increment: debit.amount },
            // Only a savings debit is savings. Loan/group money is credited to
            // the wallet so the purpose service can debit it, but it must not
            // inflate `totalSaved`.
            ...(debit.purpose === "savings"
              ? { totalSaved: { increment: debit.amount } }
              : {}),
          },
        });
        await tx.mandateDebit.update({
          where: { id: debit.id },
          data: { status: "successful", settledAt: new Date(), providerTransactionId },
        });
        await tx.mandate.update({
          where: { id: debit.mandateId },
          data: { lastDebitAt: new Date() },
        });
      });
      // The debit is already `successful` and the wallet credited; a failure to
      // apply the purpose must be surfaced (alert + log), never swallowed.
      try {
        await applyPurpose(debit, member);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("[mandates] applyPurpose failed after settlement", {
          reference,
          purpose: debit.purpose,
          err: msg,
        });
        await alertSupers(
          debit.cooperativeId,
          `Direct-debit ${reference} was collected and the wallet credited, but applying the *${debit.purpose}* purpose failed: ${msg}`,
          AlertSeverity.CRITICAL,
        ).catch(() => {});
      }

      await audit({
        cooperativeId: debit.cooperativeId,
        actorPhone: "",
        actorId: debit.memberId,
        action: "mandate.debit",
        targetType: "mandate_debit",
        targetId: debit.id,
        amount: debit.amount,
        detail: description,
      }).catch(() => {});
      return "ok";
    },
  );

  if (outcome === "no-wallet") {
    await alertSupers(
      coopId,
      `Direct-debit ${reference} settled at the provider but the member has no wallet — the debit is stranded and will be retried.`,
      AlertSeverity.CRITICAL,
    ).catch(() => {});
    throw new Error(`mandate debit ${reference}: member has no wallet`);
  }
}
