import { prisma, withTxBatch } from "../lib/prisma.js";
import { sendText, notifyMember } from "../lib/messaging.js";
import { randomInt } from "node:crypto";
import { hashOtp, verifyOtp } from "../lib/security.js";
import { normalizePhone } from "../lib/phones.js";
import { getMemberByPhone, invalidateMemberCache } from "./cooperative.js";
import { audit } from "./audit.js";
import { notifySuperAdmins } from "./withdrawals.js";

const OTP_TTL_MS = 10 * 60 * 1000;

interface ChangeData {
  newPhone?: string;
  otp?: string;
  otpExpiresAt?: number;
}

function parseData(json: string): ChangeData {
  try {
    return JSON.parse(json) as ChangeData;
  } catch {
    return {};
  }
}

/**
 * Member-initiated phone change, step 1: validate the new number and send an
 * OTP to it. The switch is NOT applied here — it needs OTP verification and a
 * super-admin approval.
 */
export async function requestPhoneChange(
  phone: string,
  rawNumber: string,
): Promise<{ ok: boolean; message: string }> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    return {
      ok: false,
      message: "You need to join a cooperative first. Reply *join <code>* to get started.",
    };
  }
  const newPhone = normalizePhone(rawNumber);
  if (!newPhone) {
    return {
      ok: false,
      message:
        "Reply *changephone <number>* with a valid number, e.g. *changephone 08012345678* or *changephone +2348012345678*.",
    };
  }
  if (newPhone === member.phone) {
    return { ok: false, message: "That's already your current number." };
  }
  const clash = await prisma.member.findFirst({
    where: { cooperativeId: member.cooperativeId, phone: newPhone, NOT: { id: member.id } },
  });
  if (clash) {
    return {
      ok: false,
      message: "That number is already linked to another member of your cooperative.",
    };
  }
  const pending = await prisma.phoneChangeRequest.findFirst({
    where: { memberId: member.id, status: "pending_approval" },
  });
  if (pending) {
    return { ok: false, message: "You already have a phone change awaiting admin approval." };
  }

  const code = String(randomInt(100000, 999999));
  const data: ChangeData = {
    newPhone,
    otp: hashOtp(code),
    otpExpiresAt: Date.now() + OTP_TTL_MS,
  };
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_changephone_otp", data: JSON.stringify(data) },
    update: { state: "awaiting_changephone_otp", data: JSON.stringify(data) },
  });
  await sendText({
    to: newPhone,
    text: `Your Coop Bank verification code is *${code}*. It expires in 10 minutes.`,
  });
  return {
    ok: true,
    message: `We sent a 6-digit code to *${newPhone}*. Reply it here to verify the new number.`,
  };
}

/**
 * Step 2: verify the OTP and open a pending approval request for the super admin.
 */
export async function verifyPhoneChangeOtp(
  phone: string,
  code: string,
): Promise<{ ok: boolean; message: string }> {
  const session = await prisma.session.findUnique({ where: { phone } });
  if (!session || session.state !== "awaiting_changephone_otp") {
    return {
      ok: false,
      message: "No phone change is in progress. Reply *changephone <number>* to start.",
    };
  }
  const data = parseData(session.data);
  if (!data.newPhone || !data.otp || !data.otpExpiresAt) {
    return {
      ok: false,
      message: "That request expired. Reply *changephone <number>* to start again.",
    };
  }
  if (data.otpExpiresAt < Date.now()) {
    return {
      ok: false,
      message: "That code expired. Reply *changephone <number>* to start again.",
    };
  }
  if (!verifyOtp(code, data.otp)) {
    return { ok: false, message: "Wrong code. Check the message on the new number and try again." };
  }
  const member = await getMemberByPhone(phone);
  if (!member) {
    return { ok: false, message: "You need to join a cooperative first." };
  }

  await prisma.phoneChangeRequest.create({
    data: {
      memberId: member.id,
      cooperativeId: member.cooperativeId,
      oldPhone: member.phone,
      newPhone: data.newPhone,
      status: "pending_approval",
      verifiedAt: new Date(),
    },
  });
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "idle", data: "{}" },
    update: { state: "idle", data: "{}" },
  });
  await notifySuperAdmins(
    member.cooperativeId,
    `📱 ${member.name} (${member.code}) verified a new number *${data.newPhone}* and is requesting to move their account from ${member.phone}. Approve with *approvephone ${member.code}*.`,
  );
  return {
    ok: true,
    message:
      "✅ New number verified. Your request is now awaiting admin approval. You'll be notified once it's approved.",
  };
}

/** Super admin approves a pending phone change and applies the switch. */
export async function approvePhoneChange(
  superPhone: string,
  rawCode: string,
): Promise<{ ok: boolean; message: string }> {
  const code = rawCode.trim().toUpperCase();
  const superM = await prisma.member.findFirst({
    where: { phone: superPhone, role: "superadmin" },
  });
  if (!superM) {
    return { ok: false, message: "Only the *super admin* can approve phone changes." };
  }
  const target = await prisma.member.findFirst({
    where: { code, cooperativeId: superM.cooperativeId },
  });
  if (!target) return { ok: false, message: `No member found with code ${code}.` };
  const req = await prisma.phoneChangeRequest.findFirst({
    where: { memberId: target.id, status: "pending_approval" },
    orderBy: { requestedAt: "desc" },
  });
  if (!req) return { ok: false, message: `${target.name} has no pending phone change.` };

  // Re-check the new number is still free (it may have been claimed since).
  const clash = await prisma.member.findFirst({
    where: { cooperativeId: superM.cooperativeId, phone: req.newPhone, NOT: { id: target.id } },
  });
  if (clash) {
    return {
      ok: false,
      message: `The number ${req.newPhone} is now linked to another member. Reject this request instead.`,
    };
  }

  const oldPhone = target.phone;
  await withTxBatch([
    prisma.member.update({
      where: { id: target.id },
      data: { phone: req.newPhone, preferredChannel: null },
    }),
    prisma.phoneChangeRequest.update({
      where: { id: req.id },
      data: { status: "approved", approvedById: superM.id, approvedAt: new Date() },
    }),
    prisma.session.deleteMany({ where: { phone: oldPhone } }),
    prisma.session.deleteMany({ where: { phone: req.newPhone } }),
  ]);
  invalidateMemberCache(oldPhone);
  invalidateMemberCache(req.newPhone);

  await sendText({
    to: oldPhone,
    text: "🔐 Your account has been moved to a new number. If this was not you, contact your co-op admin immediately.",
  }).catch(() => {});
  await notifyMember(
    { phone: req.newPhone },
    "✅ Your phone change was approved. This number is now your account. Reply *menu* to continue.",
  ).catch(() => {});
  await audit({
    cooperativeId: superM.cooperativeId,
    actorPhone: superPhone,
    actorId: superM.id,
    actorRole: "superadmin",
    action: "account.phone.change.approve",
    targetType: "member",
    targetId: target.id,
    detail: `${oldPhone} -> ${req.newPhone}`,
  });
  return {
    ok: true,
    message: `✅ ${target.name}'s account moved from ${oldPhone} to ${req.newPhone}.`,
  };
}

/** Super admin rejects a pending phone change. */
export async function rejectPhoneChange(
  superPhone: string,
  rawCode: string,
  reason?: string,
): Promise<{ ok: boolean; message: string }> {
  const code = rawCode.trim().toUpperCase();
  const superM = await prisma.member.findFirst({
    where: { phone: superPhone, role: "superadmin" },
  });
  if (!superM) {
    return { ok: false, message: "Only the *super admin* can reject phone changes." };
  }
  const target = await prisma.member.findFirst({
    where: { code, cooperativeId: superM.cooperativeId },
  });
  if (!target) return { ok: false, message: `No member found with code ${code}.` };
  const req = await prisma.phoneChangeRequest.findFirst({
    where: { memberId: target.id, status: "pending_approval" },
    orderBy: { requestedAt: "desc" },
  });
  if (!req) return { ok: false, message: `${target.name} has no pending phone change.` };

  await prisma.phoneChangeRequest.update({
    where: { id: req.id },
    data: {
      status: "rejected",
      approvedById: superM.id,
      approvedAt: new Date(),
      reason: reason ?? null,
    },
  });
  await notifyMember(
    target,
    `❌ Your request to move to ${req.newPhone} was rejected${reason ? `: ${reason}` : "."}`,
  ).catch(() => {});
  await audit({
    cooperativeId: superM.cooperativeId,
    actorPhone: superPhone,
    actorId: superM.id,
    actorRole: "superadmin",
    action: "account.phone.change.reject",
    targetType: "member",
    targetId: target.id,
    detail: `${req.newPhone}${reason ? `: ${reason}` : ""}`,
  });
  return { ok: true, message: `Phone change for ${target.name} rejected.` };
}
