import { prisma } from "../lib/prisma.js";
import { sendText } from "../lib/messaging.js";
import { resolveProvider } from "./payments/index.js";
import { formatBalance } from "./cooperative.js";
import { audit } from "./audit.js";
import { recordLedger } from "./ledger.js";
import { approvalCooldownMs, checkDailyPayoutLimit } from "./fraud.js";
import { ensureBeneficiaryAllowed } from "./beneficiaries.js";

export interface PayAnyoneResult {
  ok: boolean;
  message: string;
  paymentId?: string;
}

/**
 * Organization pays an external bank account. Any admin can initiate, but the
 * money only moves after THREE distinct super admins approve. The initiator
 * can't approve their own request, and consecutive approvals must respect a
 * short cool-off window.
 */
export async function requestExternalPayment(
  actor: { id: string; name: string; phone: string; role: string; cooperativeId: string },
  input: { beneficiaryName: string; accountNumber: string; bankCode: string; bankName?: string; amount: number; purpose?: string },
): Promise<PayAnyoneResult> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, message: "Use *payanyone <amount> <account> <bank> <name>* — amount must be positive." };
  }

  const limit = await checkDailyPayoutLimit(actor.cooperativeId, input.amount);
  if (!limit.ok) return { ok: false, message: limit.message! };

  // New-payee cooling period applies to external beneficiaries too.
  const beneficiaryCheck = await ensureBeneficiaryAllowed({
    cooperativeId: actor.cooperativeId,
    memberId: null,
    accountNumber: input.accountNumber,
    bankCode: input.bankCode,
    bankName: input.bankName ?? null,
  });
  if (!beneficiaryCheck.ok) {
    return { ok: false, message: beneficiaryCheck.message! };
  }

  const payment = await prisma.externalPayment.create({
    data: {
      cooperativeId: actor.cooperativeId,
      beneficiaryName: input.beneficiaryName,
      bankAccountNumber: input.accountNumber,
      bankCode: input.bankCode,
      bankName: input.bankName,
      amount: input.amount,
      purpose: input.purpose,
      initiatedById: actor.id,
    },
  });

  await notifySupers(actor.cooperativeId, superApprovalPrompt(payment));
  await audit({
    cooperativeId: actor.cooperativeId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "payanyone.request",
    targetType: "external_payment",
    targetId: payment.id,
    detail: `${formatBalance(input.amount)} to ${input.beneficiaryName} (${input.accountNumber.slice(-4)})`,
  });

  return {
    ok: true,
    paymentId: payment.id,
    message:
      `Pay-anyone request *${payment.id.slice(-6)}* created ✅\n` +
      `${formatBalance(input.amount)} → ${input.beneficiaryName} (${input.bankName ?? input.bankCode} ****${input.accountNumber.slice(-4)})\n\n` +
      `It needs *3 super admin approvals*. Supers have been notified.`,
  };
}

function superApprovalPrompt(p: {
  id: string;
  amount: number;
  beneficiaryName: string;
  bankName?: string | null;
  bankAccountNumber: string;
  status: string;
}) {
  const step = p.status === "pending" ? "1 of 3" : p.status === "approved1" ? "2 of 3" : "3 of 3";
  return (
    `💸 *Pay-anyone request* ${p.id.slice(-6)} (approval *${step}*)\n` +
    `${formatBalance(p.amount)} → *${p.beneficiaryName}* — ${p.bankName ?? ""} ****${p.bankAccountNumber.slice(-4)}\n\n` +
    `Super admins: *approvepay ${p.id.slice(-6)}* or reply *pendingpay* to review.`
  );
}

async function findPayment(shortId: string) {
  return prisma.externalPayment.findFirst({
    where: { OR: [{ id: shortId }, { id: { endsWith: shortId } }] },
  });
}

/**
 * A super admin approves. Rules: must be superadmin, must not be the
 * initiator, must not have approved this already, and approvals after the
 * first must wait out the cool-off window.
 */
export async function approveExternalPayment(
  actor: { id: string; name: string; phone: string; role: string; cooperativeId: string },
  shortId: string,
): Promise<PayAnyoneResult> {
  if (actor.role !== "superadmin") {
    return { ok: false, message: "Only *super admins* can approve pay-anyone requests." };
  }
  const payment = await findPayment(shortId);
  if (!payment || payment.cooperativeId !== actor.cooperativeId) {
    return { ok: false, message: "Pay-anyone request not found." };
  }
  if (["paid", "rejected", "failed"].includes(payment.status)) {
    return { ok: false, message: `Request is already ${payment.status}.` };
  }
  if (payment.initiatedById === actor.id) {
    return { ok: false, message: "⛔ You initiated this request — you can't approve it yourself." };
  }
  if (
    payment.approved1ById === actor.id ||
    payment.approved2ById === actor.id ||
    payment.approved3ById === actor.id
  ) {
    // Third approval recorded but the transfer didn't complete — allow a retry.
    if (payment.approved3ById === actor.id && payment.status === "approved2") {
      return payExternal(actor, payment.id);
    }
    return { ok: false, message: "⛔ You already approved this request." };
  }

  const cooldown = approvalCooldownMs();
  if (
    cooldown > 0 &&
    payment.lastApprovedAt &&
    Date.now() - payment.lastApprovedAt.getTime() < cooldown &&
    payment.status !== "pending"
  ) {
    const waitMin = Math.ceil((cooldown - (Date.now() - payment.lastApprovedAt.getTime())) / 60000);
    return { ok: false, message: `⏳ Cool-off active — next super approval in ~${waitMin} min.` };
  }

  // ATOMIC STEP CLAIMS — each transition only fires from the exact expected
  // state with an empty approver slot, so two supers clicking simultaneously
  // can never both occupy the same step (and thus never fast-track to 3).
  if (payment.status === "pending" && !payment.approved1ById) {
    const moved = await prisma.externalPayment.updateMany({
      where: { id: payment.id, status: "pending", approved1ById: null },
      data: { status: "approved1", approved1ById: actor.id, lastApprovedAt: new Date() },
    });
    if (moved.count === 0) {
      return { ok: false, message: "Someone just recorded an approval — check *pendingpay*." };
    }
    await notifySupers(actor.cooperativeId, superApprovalPrompt({ ...payment, status: "approved1" }));
    await logApprove(actor, payment.id, "1/3");
    return { ok: true, message: `Approval *1 of 3* recorded for ${payment.id.slice(-6)}. Two more supers needed.` };
  }

  if (payment.status === "approved1" && !payment.approved2ById) {
    const moved = await prisma.externalPayment.updateMany({
      where: { id: payment.id, status: "approved1", approved2ById: null },
      data: { status: "approved2", approved2ById: actor.id, lastApprovedAt: new Date() },
    });
    if (moved.count === 0) {
      return { ok: false, message: "Someone just recorded an approval — check *pendingpay*." };
    }
    await notifySupers(actor.cooperativeId, superApprovalPrompt({ ...payment, status: "approved2" }));
    await logApprove(actor, payment.id, "2/3");
    return { ok: true, message: `Approval *2 of 3* recorded for ${payment.id.slice(-6)}. One more super needed.` };
  }

  // Third approval — atomic slot grab, then pay. Status stays "approved2"
  // until the transfer settles, so it remains visible as actionable.
  const third = await prisma.externalPayment.updateMany({
    where: { id: payment.id, status: "approved2", approved3ById: null },
    data: { approved3ById: actor.id, lastApprovedAt: new Date() },
  });
  if (third.count === 0) {
    return { ok: false, message: "The final approval was just taken by another super admin." };
  }
  await logApprove(actor, payment.id, "3/3");
  return payExternal(actor, payment.id);
}

async function logApprove(
  actor: { id: string; phone: string; role: string; cooperativeId: string },
  paymentId: string,
  step: string,
) {
  await audit({
    cooperativeId: actor.cooperativeId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "payanyone.approve",
    targetType: "external_payment",
    targetId: paymentId,
    detail: `super approval ${step}`,
  });
}

/**
 * Third approval landed — send the money to the external bank account.
 * ATOMIC CLAIM: approved2 -> processing before touching the provider, so
 * concurrent retries can't double-send. Failures revert to approved2
 * (retryable by another super approval); the deterministic reference
 * (PAYANY-<id>) makes even provider-side retries idempotent.
 */
async function payExternal(
  actor: { id: string; name: string; phone: string; role: string; cooperativeId: string },
  paymentId: string,
): Promise<PayAnyoneResult> {
  const payment = await prisma.externalPayment.findUnique({ where: { id: paymentId } });
  if (!payment) return { ok: false, message: "Request not found." };

  const limit = await checkDailyPayoutLimit(actor.cooperativeId, payment.amount);
  if (!limit.ok) {
    await prisma.externalPayment.updateMany({
      where: { id: payment.id, status: "approved2" },
      data: { status: "pending", approved3ById: null },
    });
    return { ok: false, message: limit.message! };
  }

  // ATOMIC CLAIM — exactly one caller proceeds to the provider.
  const claimed = await prisma.externalPayment.updateMany({
    where: { id: payment.id, status: "approved2" },
    data: { status: "processing" },
  });
  if (claimed.count === 0) {
    return { ok: false, message: "This request is already being paid out or was settled — check *pendingpay*." };
  }

  const provider = resolveProvider();
  const reference = `PAYANY-${payment.id.slice(-8)}`;

  if (!provider.payout) {
    await prisma.externalPayment.updateMany({
      where: { id: payment.id, status: "processing" },
      data: { status: "failed", payoutReference: "no provider" },
    });
    return { ok: false, message: "No payment provider configured — money not sent." };
  }

  try {
    const result = await provider.payout({
      amount: payment.amount,
      bankAccountNumber: payment.bankAccountNumber,
      bankCode: payment.bankCode,
      recipientName: payment.beneficiaryName,
      reference,
    });
    if (!result.ok) {
      // Provider refused — nothing moved. Revert for a clean retry.
      await prisma.externalPayment.updateMany({
        where: { id: payment.id, status: "processing" },
        data: { status: "approved2", payoutReference: result.error ?? "payout failed" },
      });
      return { ok: false, message: `Provider refused the transfer (${result.error ?? "unknown"}). No money moved — another super can retry the final approval.` };
    }

    try {
      await prisma.$transaction([
        prisma.externalPayment.updateMany({
          where: { id: payment.id, status: "processing" },
          data: { status: "paid", payoutReference: reference },
        }),
        prisma.payout.create({
          data: {
            amount: payment.amount,
            reference,
            idempotencyKey: reference,
            status: "successful",
            provider: provider.name,
            providerRef: result.providerRef,
            note: `Pay-anyone → ${payment.beneficiaryName}${payment.purpose ? ` (${payment.purpose})` : ""}`,
            memberId: payment.initiatedById, // bookkeeping anchor
            cooperativeId: payment.cooperativeId,
          },
        }),
      ]);
    } catch (err: any) {
      if (err?.code === "P2002") {
        console.error(`[payanyone] duplicate blocked: ${reference} already paid`);
        return { ok: false, message: "Duplicate payout blocked — this exact transfer was already recorded." };
      }
      throw err;
    }

    await recordLedger({
      cooperativeId: payment.cooperativeId,
      type: "expense",
      category: "external_payment",
      amount: payment.amount,
      note: `Paid ${payment.beneficiaryName}${payment.purpose ? ` — ${payment.purpose}` : ""}`,
      reference: payment.id,
    });
    await audit({
      cooperativeId: actor.cooperativeId,
      actorPhone: actor.phone,
      actorId: actor.id,
      actorRole: actor.role,
      action: "payanyone.paid",
      targetType: "external_payment",
      targetId: payment.id,
      detail: `${formatBalance(payment.amount)} paid to ${payment.beneficiaryName}`,
    });

    const initiator = await prisma.member.findUnique({ where: { id: payment.initiatedById } });
    const doneMsg = `💸 Pay-anyone *${payment.id.slice(-6)}*: ${formatBalance(payment.amount)} paid to *${payment.beneficiaryName}*. Ref ${reference.slice(-6)}.`;
    if (initiator) await sendText({ to: initiator.phone, text: doneMsg }).catch(() => {});
    await notifySupers(payment.cooperativeId, doneMsg);
    if (limit.warning) await notifySupers(payment.cooperativeId, limit.warning);

    return { ok: true, message: doneMsg + "\n\nAll 3 super approvals complete — money sent ✅" };
  } catch (err: any) {
    // Unknown provider state — revert to approved2 so a human can retry
    // deliberately; reconciliation will flag repeated attempts.
    await prisma.externalPayment.updateMany({
      where: { id: payment.id, status: "processing" },
      data: { status: "approved2", payoutReference: String(err?.message ?? err).slice(0, 200) },
    });
    return { ok: false, message: `Transfer failed (${err?.message ?? "provider error"}). No money confirmed moved — retry the final approval if unsure.` };
  }
}

export async function rejectExternalPayment(
  actor: { id: string; phone: string; role: string; cooperativeId: string },
  shortId: string,
): Promise<PayAnyoneResult> {
  if (actor.role !== "superadmin") {
    return { ok: false, message: "Only *super admins* can reject pay-anyone requests." };
  }
  const payment = await findPayment(shortId);
  if (!payment || payment.cooperativeId !== actor.cooperativeId) {
    return { ok: false, message: "Pay-anyone request not found." };
  }
  if (payment.status === "paid") {
    return { ok: false, message: "Too late — this request was already paid." };
  }
  if (payment.status === "processing") {
    return { ok: false, message: "This transfer is mid-flight at the provider — wait for it to settle before rejecting." };
  }

  // Atomic — a reject racing the third approval can't clobber a paid state.
  const moved = await prisma.externalPayment.updateMany({
    where: { id: payment.id, status: { in: ["pending", "approved1", "approved2"] } },
    data: { status: "rejected" },
  });
  if (moved.count === 0) {
    return { ok: false, message: `Request just changed state (now ${payment.status}) — not rejected.` };
  }
  await audit({
    cooperativeId: actor.cooperativeId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "payanyone.reject",
    targetType: "external_payment",
    targetId: payment.id,
  });
  return { ok: true, message: `Pay-anyone request *${payment.id.slice(-6)}* rejected.` };
}

/** Pending pay-anyone requests (in approval order). */
export async function listPendingExternal(cooperativeId: string) {
  return prisma.externalPayment.findMany({
    where: { cooperativeId, status: { in: ["pending", "approved1", "approved2"] } },
    include: { initiator: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export async function notifySupers(cooperativeId: string, text: string) {
  const supers = await prisma.member.findMany({
    where: { cooperativeId, OR: [{ role: "superadmin" }, { role: "admin", unitId: null }] },
    select: { phone: true },
  });
  for (const s of supers) {
    await sendText({ to: s.phone, text }).catch(() => {});
  }
}
