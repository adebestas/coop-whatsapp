import { prisma, withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import { postJournal } from "./journal.js";
import { audit } from "./audit.js";
import { sendToBank } from "./disbursements.js";
import { formatBalance } from "../lib/money.js";
import { alertSupers, AlertSeverity } from "../lib/alerting.js";

export interface RefundActor {
  id: string;
  phone: string;
  role?: string | null;
}

export interface RefundResult {
  ok: boolean;
  message: string;
  refundId?: string;
}

export interface ApproveRefundOptions {
  /**
   * Set ONLY by the platform-ombudsman remedy path (`applyRemedy` in
   * `ombudsman.ts`), after it has verified an active `Ombudsman` phone. The
   * independent ombudsman is empowered to approve a remedy refund directly, so
   * the super-admin maker-checker requirement is bypassed for this call. Never
   * set from a chat/admin handler.
   */
  ombudsmanApproved?: boolean;
}

/** Resolve a refund by full id or a trailing id suffix, scoped to one coop. */
async function resolveRefund(coopId: string, idOrSuffix: string) {
  if (!idOrSuffix) return null;
  const exact = await prisma.refundRequest.findFirst({
    where: { id: idOrSuffix, cooperativeId: coopId },
  });
  if (exact) return exact;
  const matches = await prisma.refundRequest.findMany({
    where: { cooperativeId: coopId, id: { endsWith: idOrSuffix } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

/** Resolve a member by member code or id, scoped to one coop. */
async function resolveMember(coopId: string, codeOrId: string) {
  return prisma.member.findFirst({
    where: { cooperativeId: coopId, OR: [{ id: codeOrId }, { code: codeOrId }] },
  });
}

/**
 * Maker step: an admin (or super admin) recommends a refund the coop owes a
 * member — e.g. a double payment where a bank/cheque payment landed AND the
 * direct debit also pulled. Creates a `pending` request; a super admin must
 * approve before any money moves.
 */
export async function recommendRefund(
  coopId: string,
  memberId: string,
  amount: number,
  reason: string,
  actor: RefundActor,
): Promise<RefundResult> {
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, message: "Enter a positive refund amount, e.g. *recommendrefund MEM001 5000 double payment*." };
  }
  const trimmed = (reason ?? "").trim();
  if (trimmed.length < 3) {
    return { ok: false, message: "Give a short reason for the refund (at least 3 characters)." };
  }
  if (trimmed.length > 200) {
    return { ok: false, message: "Keep the refund reason under 200 characters." };
  }
  const member = await resolveMember(coopId, memberId);
  if (!member) return { ok: false, message: "Member not found in your cooperative." };

  const refund = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    return tx.refundRequest.create({
      data: {
        cooperativeId: coopId,
        memberId: member.id,
        amount,
        reason: trimmed,
        status: "pending",
        recommendedById: actor.id,
      },
    });
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role ?? null,
    action: "refund.recommend",
    targetType: "refund",
    targetId: refund.id,
    amount,
    detail: `Refund to ${member.name} — ${formatBalance(amount)} (${trimmed})`,
  }).catch(() => {});

  return {
    ok: true,
    refundId: refund.id,
    message:
      `✅ Refund *${refund.id.slice(-6)}* recommended for ${member.name}: *${formatBalance(amount)}*.\n\n` +
      `A super admin must *approverefund ${refund.id.slice(-6)}* to pay it to the member's bank account.`,
  };
}

/**
 * Checker step: only a super admin can approve. Claims the request atomically
 * (`pending` -> `approved`), pays the member's saved bank account through the
 * shared payout path, then marks `paid` (or `failed` and alerts). Reuses the
 * deterministic `Payout` row + balanced `expense:refund` / `assets:bank` journal.
 */
export async function approveRefund(
  coopId: string,
  refundId: string,
  actor: RefundActor,
  options: ApproveRefundOptions = {},
): Promise<RefundResult> {
  if (!options.ombudsmanApproved && actor.role !== "superadmin") {
    return { ok: false, message: "Only *super admins* can approve refunds." };
  }
  const refund = await resolveRefund(coopId, refundId);
  if (!refund) return { ok: false, message: "Refund request not found." };
  // A `failed` refund is retryable ONLY when the provider explicitly declined
  // (no money moved; the deterministic TFR-REFUND key keeps the retry safe).
  // An `unsure` outcome may already have sent the transfer, so re-approving it
  // could double-pay — that stays blocked until a human reconciles.
  const unsure = refund.status === "failed" && (refund.payoutRef ?? "").startsWith("unsure:");
  if (refund.status !== "pending" && (refund.status !== "failed" || unsure)) {
    return {
      ok: false,
      message: unsure
        ? "This refund's payout outcome is unconfirmed — reconcile with the provider before retrying."
        : `This refund is already ${refund.status}.`,
    };
  }
  const member = await prisma.member.findUnique({ where: { id: refund.memberId } });
  if (!member) return { ok: false, message: "Member not found." };
  if (!member.bankAccountNumber || !member.bankCode) {
    return {
      ok: false,
      message: `${member.name} has no saved bank account — add one before approving the refund.`,
    };
  }

  // ATOMIC CLAIM — exactly one approver proceeds to the provider. Runs inside a
  // cooperative-context transaction so Stage-2 FORCE RLS can resolve the tenant.
  const claimed = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    return tx.refundRequest.updateMany({
      where: { id: refund.id, status: refund.status },
      data: { status: "approved", approvedById: actor.id, approvedAt: new Date() },
    });
  });
  if (claimed.count === 0) {
    return { ok: false, message: "This refund was just handled — check its current state." };
  }

  const reference = `TFR-REFUND-${refund.id}`;
  const description = `Refund to ${member.name} — ${formatBalance(refund.amount)} (${refund.reason})`;

  const payout = await sendToBank({
    memberId: member.id,
    amount: refund.amount,
    bankAccountNumber: member.bankAccountNumber,
    bankCode: member.bankCode,
    bankName: member.bankName ?? undefined,
    note: description,
    idempotencyKey: reference,
    // The refund books its own balanced journal below; suppress payOut's generic
    // expense:payout entry so the bank account is credited exactly once.
    suppressJournal: true,
    successMessage: `💸 Refund of *${formatBalance(refund.amount)}* was sent to your bank account (${member.bankName ?? member.bankCode} ****${member.bankAccountNumber.slice(-4)}).`,
  });

  if (payout.status === "unsure") {
    await withTx(async (tx) => {
      await setCoopContext(tx as never, coopId);
      await tx.refundRequest.updateMany({
        where: { id: refund.id, status: "approved" },
        data: { status: "failed", payoutRef: `unsure: ${payout.message}`.slice(0, 200) },
      });
    });
    await alertSupers(
      coopId,
      `🔍 Refund *${refund.id.slice(-6)}* has an *unconfirmed payout outcome*. The bank transfer may have been sent but could not be confirmed. Reconcile with the payment provider before retrying or refunding.`,
      AlertSeverity.CRITICAL,
    ).catch(() => {});
    await audit({
      cooperativeId: coopId,
      actorPhone: actor.phone,
      actorId: actor.id,
      actorRole: actor.role ?? null,
      action: "refund.failed",
      targetType: "refund",
      targetId: refund.id,
      amount: refund.amount,
      detail: `Unconfirmed payout for ${member.name} — ${formatBalance(refund.amount)}`,
    }).catch(() => {});
    return {
      ok: false,
      message: `⚠️ The refund payout could not be confirmed. Do NOT retry until an admin reconciles with the provider: ${payout.message}`,
    };
  }

  if (!payout.ok) {
    await withTx(async (tx) => {
      await setCoopContext(tx as never, coopId);
      await tx.refundRequest.updateMany({
        where: { id: refund.id, status: "approved" },
        data: { status: "failed", payoutRef: payout.message.slice(0, 200) },
      });
    });
    await alertSupers(
      coopId,
      `🛑 Refund *${refund.id.slice(-6)}* for ${member.name} (${formatBalance(refund.amount)}) failed: ${payout.message}`,
      AlertSeverity.CRITICAL,
    ).catch(() => {});
    await audit({
      cooperativeId: coopId,
      actorPhone: actor.phone,
      actorId: actor.id,
      actorRole: actor.role ?? null,
      action: "refund.failed",
      targetType: "refund",
      targetId: refund.id,
      amount: refund.amount,
      detail: `Failed refund to ${member.name} — ${formatBalance(refund.amount)} (${payout.message})`,
    }).catch(() => {});
    return { ok: false, message: `Refund not paid out: ${payout.message}` };
  }

  // Balanced journal pair: the refund leaves the coop bank account.
  try {
    const posted = await postJournal({
      cooperativeId: coopId,
      txRef: `REFUND-${refund.id}`,
      description,
      postings: [
        { account: "expense:refund", direction: "DEBIT", amount: refund.amount },
        { account: "assets:bank", direction: "CREDIT", amount: refund.amount },
      ],
    });
    if (!posted.posted) {
      await alertSupers(
        coopId,
        `Journal for refund ${refund.id.slice(-6)} did not post (${posted.reason}). Books may be out of balance — resolve manually.`,
        AlertSeverity.CRITICAL,
      ).catch(() => {});
    }
  } catch (err) {
    console.error("[refund] journal post failed:", err);
    await alertSupers(
      coopId,
      `Journal entry failed for refund ${refund.id.slice(-6)}. Books will be out of balance until resolved manually.`,
      AlertSeverity.CRITICAL,
    ).catch(() => {});
  }

  await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    await tx.refundRequest.updateMany({
      where: { id: refund.id, status: "approved" },
      data: { status: "paid", paidAt: new Date(), payoutRef: reference },
    });
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role ?? null,
    action: "refund.paid",
    targetType: "refund",
    targetId: refund.id,
    amount: refund.amount,
    detail: description,
  }).catch(() => {});

  return {
    ok: true,
    message: `✅ Refund *${refund.id.slice(-6)}*: *${formatBalance(refund.amount)}* paid to ${member.name}. Ref ${reference.slice(-6)}.`,
  };
}

/**
 * Checker step: only a super admin can reject a pending refund. The rejection
 * reason is appended to the record so the original recommendation reason is kept
 * for the audit trail.
 */
export async function rejectRefund(
  coopId: string,
  refundId: string,
  reason: string,
  actor: RefundActor,
): Promise<RefundResult> {
  if (actor.role !== "superadmin") {
    return { ok: false, message: "Only *super admins* can reject refunds." };
  }
  const refund = await resolveRefund(coopId, refundId);
  if (!refund) return { ok: false, message: "Refund request not found." };
  if (refund.status !== "pending") {
    return { ok: false, message: `This refund is already ${refund.status}.` };
  }
  const trimmed = (reason ?? "").trim();
  const rejectedMember = await prisma.member.findUnique({
    where: { id: refund.memberId },
    select: { name: true },
  });

  const moved = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    return tx.refundRequest.updateMany({
      where: { id: refund.id, status: "pending" },
      data: {
        status: "rejected",
        reason: trimmed ? `${refund.reason} (rejected: ${trimmed})` : refund.reason,
      },
    });
  });
  if (moved.count === 0) {
    return { ok: false, message: "This refund just changed state — check its current state." };
  }

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role ?? null,
    action: "refund.reject",
    targetType: "refund",
    targetId: refund.id,
    amount: refund.amount,
    detail: `Refund to ${rejectedMember?.name ?? "member"} of ${formatBalance(refund.amount)} rejected${trimmed ? `: ${trimmed}` : ""}`,
  }).catch(() => {});

  return {
    ok: true,
    message: `Refund *${refund.id.slice(-6)}* rejected.${trimmed ? ` Reason: ${trimmed}.` : ""}`,
  };
}
