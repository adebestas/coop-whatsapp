import { randomInt } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { notifyMember } from "../lib/messaging.js";
import { hashOtp, verifyOtp } from "../lib/security.js";
import { formatBalance } from "./cooperative.js";
import { audit } from "./audit.js";
import { requestWithdrawal } from "./withdrawals.js";
import { assertNotRevoked } from "./revocation.js";

const OTP_TTL_MS = 10 * 60 * 1000;

export interface AssistResult {
  ok: boolean;
  message: string;
  assistId?: string;
}

async function findAction(cooperativeId: string, shortId: string) {
  const exact = await prisma.adminAssistAction.findFirst({
    where: { id: shortId, cooperativeId },
  });
  const matches = await prisma.adminAssistAction.findMany({
    where: {
      cooperativeId,
      status: "pending",
      id: { endsWith: shortId },
    },
    take: 2,
  });
  if (matches.length === 1) return matches[0];
  return exact;
}

/**
 * Superadmin-initiated, member-confirmed withdrawal. The member's one-time
 * code is the standing consent — the code goes to the MEMBER, who relays it
 * to the admin. Actual money movement still runs through the standard
 * maker-checker withdrawal path (admin approve + super finalize + idempotency).
 */
export async function startAssistWithdrawal(
  actorPhone: string,
  memberCode: string,
  amountNaira: number,
): Promise<AssistResult> {
  const actor = await prisma.member.findFirst({ where: { phone: actorPhone } });
  if (!actor) return { ok: false, message: "You need to be an admin of a cooperative first." };
  if (!Number.isFinite(amountNaira) || amountNaira <= 0) {
    return { ok: false, message: "Usage: *assistwithdraw <member code> <amount>*" };
  }
  const amount = Math.round(amountNaira * 100);

  const target = await prisma.member.findFirst({
    where: { code: memberCode.trim().toUpperCase(), cooperativeId: actor.cooperativeId },
    include: { wallet: true },
  });
  if (!target) return { ok: false, message: `No member with code *${memberCode}* in this cooperative.` };
  if (target.id === actor.id) {
    return { ok: false, message: "You can't assist a withdrawal for yourself — dual control is required." };
  }
  if (target.frozenAt) return { ok: false, message: `${target.name}'s wallet is frozen.` };
  if (target.status === "deceased") return { ok: false, message: "This account is under a death claim." };
  const revoke = await assertNotRevoked(target.id);
  if (revoke.blocked) return { ok: false, message: revoke.message };
  if (!target.bankAccountNumber || !target.bankCode) {
    return { ok: false, message: `${target.name} has no bank account on file — a withdrawal can't be routed.` };
  }
  const balance = target.wallet?.balance ?? 0;
  if (amount > balance) {
    return { ok: false, message: `Insufficient balance (${formatBalance(balance)}).` };
  }

  const otp = String(randomInt(100000, 999999));
  const otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);

  const action = await prisma.adminAssistAction.create({
    data: {
      cooperativeId: actor.cooperativeId,
      type: "withdrawal",
      targetMemberId: target.id,
      initiatorId: actor.id,
      amount,
      metadata: { memberName: target.name },
      otp: hashOtp(otp),
      otpExpiresAt,
    },
  });

  const delivered = await notifyMember(target,
    `🔐 *Admin-assisted withdrawal*\n\n` +
      `An admin wants to authorise a withdrawal of *${formatBalance(amount)}* for you.\n\n` +
      `To approve, give this one-time code to your admin:\n*${otp}*\n\n` +
      `It expires in 10 minutes. Never share it with anyone except your admin.`,
  ).catch(() => false);

  await audit({
    cooperativeId: actor.cooperativeId,
    actorPhone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "assist.withdrawal.initiate",
    targetType: "member",
    targetId: target.id,
    detail: `assist ${action.id.slice(-6)} for ${target.name}, amount ${formatBalance(amount)}`,
  });

  return {
    ok: true,
    assistId: action.id,
    message:
      `OTP sent to *${target.name}*.\n\n` +
      `Ask them for the code, then run:\n*confirmassist ${action.id.slice(-6)} <code>*\n\n` +
      (delivered ? "" : "_Could not deliver the code — ask the member to reply manually._"),
  };
}

/** Verify the member's relayed code and open the standard withdrawal request. */
export async function confirmAssistWithdrawal(
  actorPhone: string,
  shortId: string,
  code: string,
): Promise<AssistResult> {
  const actor = await prisma.member.findFirst({ where: { phone: actorPhone } });
  if (!actor) return { ok: false, message: "You need to be an admin of a cooperative first." };
  if (!code || !shortId) return { ok: false, message: "Usage: *confirmassist <assist id> <code>*" };

  const action = await findAction(actor.cooperativeId, shortId.trim());
  if (!action) return { ok: false, message: `No pending assist for id *${shortId}*.` };
  if (action.type !== "withdrawal") return { ok: false, message: "That assist isn't a withdrawal." };
  if (action.status !== "pending") {
    return { ok: false, message: `That assist has already been *${action.status}*.` };
  }

  const now = new Date();
  if (now > action.otpExpiresAt) {
    await prisma.adminAssistAction.update({ where: { id: action.id }, data: { status: "expired" } });
    return { ok: false, message: "The authorisation code has expired. Run *assistwithdraw* again to start over." };
  }
  if (!verifyOtp(code.trim(), action.otp)) {
    return { ok: false, message: "❌ Incorrect authorisation code. Ask the member for the right code." };
  }

  const target = await prisma.member.findUnique({ where: { id: action.targetMemberId }, include: { wallet: true } });
  const balance = target?.wallet?.balance ?? 0;
  if (!target || action.amount > balance) {
    await prisma.adminAssistAction.update({ where: { id: action.id }, data: { status: "cancelled" } });
    return { ok: false, message: `Code accepted, but the member's balance (${target ? formatBalance(balance) : "—"}) is now too low. Assist cancelled — investigate.` };
  }

  await prisma.adminAssistAction.update({
    where: { id: action.id },
    data: { status: "confirmed", confirmedAt: now, confirmedBy: actor.phone },
  });

  const wd = await requestWithdrawal(target.phone, action.amount);
  if (!wd.ok) {
    return { ok: false, message: `Code accepted, but the withdrawal couldn't open: ${wd.message}` };
  }

  await audit({
    cooperativeId: action.cooperativeId,
    actorPhone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "assist.withdrawal.confirm",
    targetType: "member",
    targetId: target.id,
    detail: `assist ${action.id.slice(-6)} → withdrawal ${action.amount}`,
  });

  return { ok: true, message: `✅ Authorisation confirmed. ${wd.message}` };
}
