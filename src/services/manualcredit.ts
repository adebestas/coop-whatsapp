import { prisma } from "../lib/prisma.js";
import { notifyMember } from "../lib/messaging.js";
import { formatBalance } from "./cooperative.js";
import { recordLedger } from "./ledger.js";
import { audit } from "./audit.js";

/**
 * Maker-Checker manual credits.
 *
 * Every internal wallet credit (an administrator fixing an error, an external
 * top-up not tied to a payment provider, a refund, etc.) MUST flow through a
 * two-tier pipeline so there is no unilateral `admin credit` that can move
 * wallet money. A maker (super admin) submits a PENDING credit; a DIFFERENT
 * super admin (the checker) approves it with 2FA/PIN sign-off before any
 * wallet balance is touched. Every step is journaled and audited (immutable).
 */

export interface ManualCreditResult {
  ok: boolean;
  message: string;
  creditId?: string;
}

export async function requestManualCredit(
  actorPhone: string,
  memberCode: string,
  amountNaira: number,
  narration: string,
): Promise<ManualCreditResult> {
  const actor = await prisma.member.findFirst({ where: { phone: actorPhone } });
  if (!actor) return { ok: false, message: "You need to be an admin of a cooperative first." };

  const amount = Math.round(amountNaira * 100);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Usage: *manualcredit <member code> <amount> <narration>*" };
  }
  if (!narration.trim() || narration.trim().length < 3) {
    return { ok: false, message: "A narration (reason for the credit) is required — e.g. *manualcredit MEM001 5000 Refund for July*" };
  }

  const target = await prisma.member.findFirst({
    where: { code: memberCode.trim().toUpperCase(), cooperativeId: actor.cooperativeId },
  });
  if (!target) return { ok: false, message: `No member with code *${memberCode}* in this cooperative.` };
  if (target.id === actor.id) {
    return { ok: false, message: "You can't credit yourself — another super admin must approve the credit (dual control)." };
  }

  const credit = await prisma.manualCredit.create({
    data: {
      cooperativeId: actor.cooperativeId,
      memberId: target.id,
      initiatorId: actor.id,
      amount,
      narration: narration.trim(),
    },
  });

  await audit({
    cooperativeId: actor.cooperativeId,
    actorPhone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "manual_credit.initiate",
    targetType: "member",
    targetId: target.id,
    detail: `manual credit ${credit.id.slice(-6)} to ${target.name}, amount ${formatBalance(amount)}, narration: ${narration.trim()}`,
  });

  // Notify all other super admins that a credit awaits their dual sign-off.
  const otherSupers = await prisma.member.findMany({
    where: { cooperativeId: actor.cooperativeId, role: "superadmin", id: { not: actor.id }, status: "active" },
  });
  for (const s of otherSupers) {
    await notifyMember(s,
      `🧾 *Pending manual credit*\n\n` +
        `*${actor.name}* wants to credit *${target.name}* with *${formatBalance(amount)}*.\n` +
        `Narration: ${narration.trim()}\n\n` +
        `Approve (dual control) or reject:\n*approvemanualcredit ${credit.id.slice(-6)} <your PIN>*\n` +
        `*rejectmanualcredit ${credit.id.slice(-6)}*`,
    ).catch(() => false);
  }

  return {
    ok: true,
    creditId: credit.id,
    message:
      `✅ Credit request *${credit.id.slice(-6)}* created for *${target.name}* (${formatBalance(amount)}).\n\n` +
      `Another super admin must approve it with their PIN: *approvemanualcredit ${credit.id.slice(-6)} <PIN>*`,
  };
}

export async function approveManualCredit(
  actorPhone: string,
  shortId: string,
  pin: string,
): Promise<ManualCreditResult> {
  const actor = await prisma.member.findFirst({ where: { phone: actorPhone } });
  if (!actor) return { ok: false, message: "You need to be an admin of a cooperative first." };
  if (!pin) return { ok: false, message: "Usage: *approvemanualcredit <credit id> <your PIN>*" };

  const credit = await findManualCredit(actor.cooperativeId, shortId.trim());
  if (!credit) return { ok: false, message: `No manual credit matching *${shortId}*.` };
  if (credit.status !== "pending") {
    return { ok: false, message: `That credit is already *${credit.status}*.` };
  }
  if (credit.initiatorId === actor.id) {
    return { ok: false, message: "You can't approve a credit you initiated yourself — dual control requires a different super admin." };
  }

  const target = await prisma.member.findUnique({
    where: { id: credit.memberId },
    include: { wallet: true },
  });
  if (!target) return { ok: false, message: "The target member no longer exists." };

  // Atomic: credit the wallet, record the contribution, mark approved, journal.
  const result = await prisma.$transaction(async (tx) => {
    const wallet = target.wallet ?? (await tx.wallet.create({
      data: { memberId: target.id },
    }));

    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: credit.amount } },
    });

    await tx.contribution.create({
      data: {
        amount: credit.amount,
        type: "manual",
        note: `Manual credit (${credit.narration})`,
        reference: `MC-${credit.id.slice(-8)}`,
        status: "confirmed",
        paidAt: new Date(),
        memberId: target.id,
        cooperativeId: credit.cooperativeId,
      },
    });

    await tx.manualCredit.update({
      where: { id: credit.id },
      data: { status: "approved", approvedById: actor.id, approvedAt: new Date() },
    });

    await recordLedger({
      cooperativeId: credit.cooperativeId,
      type: "income",
      category: "other",
      amount: credit.amount,
      note: `Manual credit to ${target.name} — ${credit.narration}`,
      reference: `MC-${credit.id.slice(-8)}`,
      txRef: `mc_${credit.id}`,
      tx,
    });

    return wallet.balance + credit.amount;
  });

  await audit({
    cooperativeId: credit.cooperativeId,
    actorPhone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "manual_credit.approve",
    targetType: "member",
    targetId: target.id,
    detail: `approved manual credit ${credit.id.slice(-6)} to ${target.name}, amount ${formatBalance(credit.amount)}`,
  });

  await notifyMember(target,
    `✅ *You received a credit*\n\n` +
      `*${formatBalance(credit.amount)}* has been added to your wallet.\n` +
      `Narration: ${credit.narration}\n` +
      `New balance: *${formatBalance(result)}*`,
  ).catch(() => false);

  return {
    ok: true,
    message: `✅ Credit approved. *${target.name}* has been credited ${formatBalance(credit.amount)}.`,
  };
}

export async function rejectManualCredit(
  actorPhone: string,
  shortId: string,
  reason?: string,
): Promise<ManualCreditResult> {
  const actor = await prisma.member.findFirst({ where: { phone: actorPhone } });
  if (!actor) return { ok: false, message: "You need to be an admin of a cooperative first." };

  const credit = await findManualCredit(actor.cooperativeId, shortId.trim());
  if (!credit) return { ok: false, message: `No manual credit matching *${shortId}*.` };
  if (credit.status !== "pending") {
    return { ok: false, message: `That credit is already *${credit.status}*.` };
  }

  await prisma.manualCredit.update({
    where: { id: credit.id },
    data: { status: "rejected", rejectedById: actor.id, rejectedAt: new Date() },
  });

  await audit({
    cooperativeId: credit.cooperativeId,
    actorPhone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "manual_credit.reject",
    targetType: "member",
    targetId: credit.memberId,
    detail: `rejected manual credit ${credit.id.slice(-6)}, amount ${formatBalance(credit.amount)}, reason: ${reason?.trim() ?? "none"}`,
  });

  return {
    ok: true,
    message: `Credit request *${credit.id.slice(-6)}* rejected. No balance was changed.`,
  };
}

async function findManualCredit(cooperativeId: string, shortId: string) {
  const exact = await prisma.manualCredit.findFirst({
    where: { id: shortId, cooperativeId },
  });
  const pending = await prisma.manualCredit.findMany({
    where: { cooperativeId, status: "pending", id: { endsWith: shortId } },
    take: 2,
  });
  if (pending.length === 1) return pending[0];
  return exact;
}
