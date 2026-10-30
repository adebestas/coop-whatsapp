import { prisma, withTx } from "../lib/prisma.js";
import { generateGuarantorCode } from "../lib/security.js";
import { notifyMember } from "../lib/messaging.js";
import { normalizePhone } from "../lib/phones.js";
import { formatBalance, getMemberByPhone } from "./cooperative.js";
import {
  GUARANTOR_EXPOSURE_RATIO,
  GUARANTOR_MAX_ACTIVE,
  GUARANTOR_TENURE_THRESHOLD,
  type GuarantorResult,
} from "./guarantors.js";
import { audit } from "./audit.js";

const LIVE_LOAN_STATUSES = [
  "guaranteed",
  "admin_approved",
  "super_approved_1",
  "approved",
  "disbursed",
];
const GUARANTOR_MIN_TENURE_MS = 3 * 30 * 24 * 60 * 60 * 1000;
const ADMIN_ROLES = ["admin", "superadmin"];

function loanLabel(loanId: string): string {
  return `L-${loanId.slice(-6).toUpperCase()}`;
}

function makeSubstitutionRef(): string {
  return `SUB-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

async function uniqueSubstitutionCode(): Promise<string> {
  let code = generateGuarantorCode();
  while (await prisma.guarantorSubstitution.findUnique({ where: { code } })) {
    code = generateGuarantorCode();
  }
  return code;
}

async function uniqueConfirmedCode(): Promise<string> {
  let code = generateGuarantorCode();
  while (await prisma.guarantor.findUnique({ where: { code } })) {
    code = generateGuarantorCode();
  }
  return code;
}

interface GuarantorCandidate {
  id: string;
  name: string;
  phone: string;
  cooperativeId: string;
  createdAt: Date;
  role: string;
}

async function resolveCandidate(
  raw: string,
  cooperativeId: string,
): Promise<{ candidate?: GuarantorCandidate; error?: string }> {
  const token = raw.trim();
  if (!token) return { error: "Missing member code." };
  const asPhone = normalizePhone(token);
  if (asPhone) {
    const byPhone = await getMemberByPhone(asPhone, cooperativeId);
    if (!byPhone) {
      return { error: `No member of *your* cooperative is on the number *${token}*.` };
    }
    return { candidate: byPhone as GuarantorCandidate };
  }
  const member = await prisma.member.findUnique({ where: { code: token.toUpperCase() } });
  if (!member || member.cooperativeId !== cooperativeId) {
    return { error: `No member found with code *${token.toUpperCase()}*.` };
  }
  return { candidate: member as GuarantorCandidate };
}

async function liveExposure(memberId: string, excludeLoanId?: string): Promise<number> {
  const rows = await prisma.guarantor.findMany({
    where: {
      memberId,
      status: "confirmed",
      ...(excludeLoanId ? { loanId: { not: excludeLoanId } } : {}),
      loan: { status: { in: LIVE_LOAN_STATUSES } },
    },
    select: { loan: { select: { balance: true, amount: true } } },
  });
  return rows.reduce((sum, g) => sum + (g.loan.balance > 0 ? g.loan.balance : g.loan.amount), 0);
}

async function liveGuaranteeCount(memberId: string, excludeLoanId?: string): Promise<number> {
  return prisma.guarantor.count({
    where: {
      memberId,
      status: "confirmed",
      ...(excludeLoanId ? { loanId: { not: excludeLoanId } } : {}),
      loan: { status: { in: LIVE_LOAN_STATUSES } },
    },
  });
}

async function checkNewGuarantor(
  candidate: GuarantorCandidate,
  borrowerId: string,
  loanId: string,
  loanBalance: number,
  borrowerCooperativeId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (candidate.id === borrowerId) {
    return { ok: false, message: "The borrower can't be their own guarantor." };
  }
  const already = await prisma.guarantor.findFirst({
    where: { loanId, memberId: candidate.id, status: { not: "released" } },
  });
  if (already) {
    return { ok: false, message: `*${candidate.name}* is already a guarantor on this loan.` };
  }
  const count = await liveGuaranteeCount(candidate.id);
  if (count >= GUARANTOR_MAX_ACTIVE) {
    return {
      ok: false,
      message: `*${candidate.name}* is already guarantor for *${GUARANTOR_MAX_ACTIVE}* active loans.`,
    };
  }
  const memberCount = await prisma.member.count({
    where: { cooperativeId: borrowerCooperativeId },
  });
  if (memberCount >= GUARANTOR_TENURE_THRESHOLD) {
    const tenure = Date.now() - candidate.createdAt.getTime();
    if (tenure < GUARANTOR_MIN_TENURE_MS) {
      return {
        ok: false,
        message: `*${candidate.name}* joined less than 3 months ago; guarantors need 3+ months of membership in a cooperative this size.`,
      };
    }
    const wallet = await prisma.wallet.findUnique({ where: { memberId: candidate.id } });
    const limit = Math.floor((wallet?.totalSaved ?? 0) * GUARANTOR_EXPOSURE_RATIO);
    const exposure = await liveExposure(candidate.id);
    if (exposure + loanBalance > limit) {
      return {
        ok: false,
        message:
          `*${candidate.name}* can't take on this guarantee - guarantees are capped at *${GUARANTOR_EXPOSURE_RATIO}x savings*.\n` +
          `Their limit: ${formatBalance(limit)} (already guaranteeing ${formatBalance(exposure)}).`,
      };
    }
  }
  return { ok: true };
}

async function resolveLoan(raw: string, cooperativeId: string) {
  const token = (raw ?? "").trim();
  if (!token) return null;
  return prisma.loan.findFirst({
    where: {
      cooperativeId,
      ...(token.length >= 8 ? { id: token } : { id: { endsWith: token } }),
    },
    include: { member: true, guarantors: { include: { member: true } } },
  });
}

async function notifyAdmins(cooperativeId: string, text: string): Promise<void> {
  const admins = await prisma.member.findMany({
    where: { cooperativeId, role: { in: ADMIN_ROLES }, status: "active" },
    select: { phone: true, altChannelId: true, preferredChannel: true, optedOut: true },
  });
  await Promise.all(admins.map((admin) => notifyMember(admin, text).catch(() => undefined)));
}

export async function requestSubstitution(
  phone: string,
  loanRaw: string,
  oldRaw: string,
  newRaw: string,
): Promise<GuarantorResult> {
  const borrower = await getMemberByPhone(phone);
  if (!borrower) return { ok: false, message: "You need to join a cooperative first." };
  if (!loanRaw || !oldRaw || !newRaw) {
    return {
      ok: false,
      message: "Usage: *substituteguarantor <loan id> <old guarantor code> <new guarantor code>*",
    };
  }

  const loan = await resolveLoan(loanRaw, borrower.cooperativeId);
  if (!loan) return { ok: false, message: "That loan doesn't exist." };
  if (loan.memberId !== borrower.id) {
    return { ok: false, message: "That loan doesn't belong to you." };
  }
  if (!LIVE_LOAN_STATUSES.includes(loan.status)) {
    return { ok: false, message: `This loan can't swap guarantors (status: ${loan.status}).` };
  }
  if (loan.balance <= 0) {
    return { ok: false, message: "This loan is fully settled - no guarantor is needed." };
  }

  const oldResolved = await resolveCandidate(oldRaw, borrower.cooperativeId);
  if (!oldResolved.candidate) {
    return { ok: false, message: oldResolved.error ?? "Old guarantor not found." };
  }
  const oldGuarantor = await prisma.guarantor.findFirst({
    where: { loanId: loan.id, memberId: oldResolved.candidate.id, status: "confirmed" },
  });
  if (!oldGuarantor) {
    return {
      ok: false,
      message: `*${oldResolved.candidate.name}* is not a confirmed guarantor on ${loanLabel(loan.id)}.`,
    };
  }

  const pending = await prisma.guarantorSubstitution.findFirst({
    where: {
      loanId: loan.id,
      oldGuarantorId: oldGuarantor.id,
      status: { in: ["pending_guarantor", "pending_admin"] },
    },
  });
  if (pending) {
    return {
      ok: false,
      message: `A substitution for that guarantor is already in progress (*${pending.reference}*).`,
    };
  }

  const newResolved = await resolveCandidate(newRaw, borrower.cooperativeId);
  if (!newResolved.candidate) {
    return { ok: false, message: newResolved.error ?? "New guarantor not found." };
  }
  const candidate = newResolved.candidate;
  if (candidate.id === oldResolved.candidate.id) {
    return { ok: false, message: "The new guarantor must be a different member." };
  }
  const eligible = await checkNewGuarantor(
    candidate,
    borrower.id,
    loan.id,
    loan.balance,
    borrower.cooperativeId,
  );
  if (!eligible.ok) return { ok: false, message: eligible.message };

  const code = await uniqueSubstitutionCode();
  const reference = makeSubstitutionRef();
  const substitution = await prisma.guarantorSubstitution.create({
    data: {
      reference,
      cooperativeId: borrower.cooperativeId,
      loanId: loan.id,
      oldGuarantorId: oldGuarantor.id,
      newMemberId: candidate.id,
      requestedById: borrower.id,
      code,
      status: "pending_guarantor",
    },
  });

  await notifyMember(
    candidate,
    `🔄 *Guarantor substitution request*\n\n` +
      `*${borrower.name}* wants you to replace *${oldResolved.candidate.name}* as guarantor on loan *${loanLabel(loan.id)}* ` +
      `(outstanding ${formatBalance(loan.balance)}).\n\n` +
      `To accept, reply:\n*confirm ${code}*\n\n` +
      `An admin must approve the swap before it takes effect.`,
  ).catch((err) => console.error("[substitution] notify new guarantor failed", err));

  void notifyAdmins(
    borrower.cooperativeId,
    `🔄 *Substitution requested* - ${borrower.name} wants *${candidate.name}* to replace *${oldResolved.candidate.name}* on loan *${loanLabel(loan.id)}*.\n` +
      `Reference: *${reference}*. Approve with *approvesubstitution ${reference}* once the new guarantor confirms.`,
  ).catch((err) => console.error("[substitution] notify admins failed", err));

  return {
    ok: true,
    message:
      `🔄 Substitution request *${substitution.reference}* created.\n\n` +
      `*${candidate.name}* must reply *confirm ${code}*. An admin then approves with *approvesubstitution ${reference}*.\n\n` +
      `Until then, *${oldResolved.candidate.name}* remains liable.`,
  };
}

/**
 * Confirm a substitution code. Returns null when the code is not a substitution
 * code, so the caller can fall back to the ordinary guarantor confirmation.
 */
export async function confirmSubstitution(
  phone: string,
  rawCode: string,
): Promise<GuarantorResult | null> {
  const code = (rawCode ?? "").trim().toUpperCase();
  if (!code) return null;
  const substitution = await prisma.guarantorSubstitution.findUnique({
    where: { code },
    include: {
      newMember: true,
      requestedBy: true,
      oldGuarantor: { include: { member: true } },
      loan: { select: { id: true, balance: true } },
    },
  });
  if (!substitution) return null;
  if (substitution.newMember.phone !== phone) {
    return { ok: false, message: "This confirmation code belongs to another member's WhatsApp." };
  }
  if (substitution.status === "approved") {
    return { ok: true, message: "This substitution has already been approved." };
  }
  if (substitution.status === "rejected" || substitution.status === "cancelled") {
    return { ok: false, message: "This substitution request is no longer active." };
  }
  if (substitution.status === "pending_admin") {
    return {
      ok: true,
      message: `You already accepted. Waiting for an admin to approve *${substitution.reference}*.`,
    };
  }

  await prisma.guarantorSubstitution.update({
    where: { id: substitution.id },
    data: { status: "pending_admin", confirmedAt: new Date() },
  });

  const label = loanLabel(substitution.loan.id);
  const oldName = substitution.oldGuarantor.member.name;
  await notifyMember(
    substitution.requestedBy,
    `✅ *${substitution.newMember.name}* accepted the guarantor swap on *${label}*.\n` +
      `Reference *${substitution.reference}* is now waiting for admin approval.`,
  ).catch(() => undefined);
  void notifyAdmins(
    substitution.cooperativeId,
    `✅ *${substitution.newMember.name}* confirmed the swap for *${label}* (reference *${substitution.reference}*).\n` +
      `Approve with *approvesubstitution ${substitution.reference}* to release *${oldName}*.`,
  ).catch(() => undefined);

  return {
    ok: true,
    message:
      `✅ You accepted the guarantor substitution on *${label}*.\n\n` +
      `You are not liable yet - an admin must approve *${substitution.reference}* first.`,
  };
}

async function adminActor(phone: string) {
  const member = await getMemberByPhone(phone);
  if (!member) return null;
  if (!ADMIN_ROLES.includes(member.role)) return null;
  return member;
}

async function findSubstitution(raw: string, cooperativeId: string) {
  const token = (raw ?? "").trim();
  if (!token) return null;
  return prisma.guarantorSubstitution.findFirst({
    where: {
      cooperativeId,
      OR: [{ reference: token.toUpperCase() }, { code: token.toUpperCase() }, { id: token }],
    },
    include: {
      newMember: true,
      requestedBy: true,
      oldGuarantor: { include: { member: true } },
      loan: { select: { id: true, balance: true, status: true } },
    },
  });
}

export async function approveSubstitution(phone: string, rawRef: string): Promise<GuarantorResult> {
  const admin = await adminActor(phone);
  if (!admin) return { ok: false, message: "Only an admin can approve a substitution." };
  if (!rawRef) return { ok: false, message: "Usage: *approvesubstitution <reference>*" };

  const substitution = await findSubstitution(rawRef, admin.cooperativeId);
  if (!substitution) return { ok: false, message: "Substitution not found." };
  if (substitution.status === "approved") {
    return { ok: true, message: "That substitution is already approved." };
  }
  if (substitution.status !== "pending_admin") {
    return {
      ok: false,
      message:
        substitution.status === "pending_guarantor"
          ? `*${substitution.newMember.name}* hasn't confirmed yet. Ask them to reply *confirm ${substitution.code}*.`
          : `This substitution can't be approved (status: ${substitution.status}).`,
    };
  }
  if (substitution.loan.status === "paid") {
    return {
      ok: false,
      message: "This loan is already settled - releasing the guarantor is unnecessary.",
    };
  }

  const candidate = await prisma.member.findUnique({ where: { id: substitution.newMemberId } });
  if (!candidate) return { ok: false, message: "The new guarantor no longer exists." };
  const eligible = await checkNewGuarantor(
    candidate as GuarantorCandidate,
    substitution.requestedById,
    substitution.loanId,
    Math.max(substitution.loan.balance, 0),
    substitution.cooperativeId,
  );
  if (!eligible.ok) return { ok: false, message: eligible.message };

  const label = loanLabel(substitution.loanId);
  await withTx(async (tx) => {
    const newCode = await uniqueConfirmedCode();
    await tx.guarantor.create({
      data: {
        loanId: substitution.loanId,
        memberId: substitution.newMemberId,
        code: newCode,
        status: "confirmed",
        confirmedAt: new Date(),
      },
    });
    await tx.guarantor.update({
      where: { id: substitution.oldGuarantorId },
      data: {
        status: "released",
        releasedAt: new Date(),
        releasedReason: `Substituted by ${substitution.newMember.name} (${substitution.reference})`,
      },
    });
    await tx.guarantorSubstitution.update({
      where: { id: substitution.id },
      data: { status: "approved", decidedAt: new Date(), decidedById: admin.id },
    });
  });

  await notifyMember(
    substitution.oldGuarantor.member,
    `🛡️ You have been formally released from guaranteeing loan *${label}*.`,
  ).catch((err) => console.error("[substitution] release notify failed", err));
  await notifyMember(
    substitution.newMember,
    `🛡️ You are now the confirmed guarantor for loan *${label}* ` +
      `(outstanding ${formatBalance(substitution.loan.balance)}).\n\n` +
      `The previous guarantor has been released.`,
  ).catch((err) => console.error("[substitution] new guarantor notify failed", err));
  await notifyMember(
    substitution.requestedBy,
    `✅ Your guarantor substitution on *${label}* was approved.\n` +
      `*${substitution.newMember.name}* now guarantees the loan; *${substitution.oldGuarantor.member.name}* is released.`,
  ).catch(() => undefined);

  await audit({
    cooperativeId: substitution.cooperativeId,
    actorPhone: phone,
    actorId: admin.id,
    action: "guarantor.substitution.approved",
    targetType: "loan",
    targetId: substitution.loanId,
    detail: `${substitution.oldGuarantor.member.name} -> ${substitution.newMember.name} (${substitution.reference})`,
  }).catch(() => undefined);

  return {
    ok: true,
    message:
      `✅ Substitution *${substitution.reference}* approved.\n\n` +
      `*${substitution.newMember.name}* now guarantees *${label}*; *${substitution.oldGuarantor.member.name}* has been released.`,
  };
}

export async function rejectSubstitution(
  phone: string,
  rawRef: string,
  reason?: string,
): Promise<GuarantorResult> {
  const admin = await adminActor(phone);
  if (!admin) return { ok: false, message: "Only an admin can reject a substitution." };
  if (!rawRef) return { ok: false, message: "Usage: *rejectsubstitution <reference> [reason]*" };

  const substitution = await findSubstitution(rawRef, admin.cooperativeId);
  if (!substitution) return { ok: false, message: "Substitution not found." };
  if (!["pending_guarantor", "pending_admin"].includes(substitution.status)) {
    return {
      ok: false,
      message: `This substitution can't be rejected (status: ${substitution.status}).`,
    };
  }

  const note = (reason ?? "").trim() || "Rejected by an admin.";
  await prisma.guarantorSubstitution.update({
    where: { id: substitution.id },
    data: { status: "rejected", reason: note, decidedAt: new Date(), decidedById: admin.id },
  });

  const label = loanLabel(substitution.loanId);
  await notifyMember(
    substitution.newMember,
    `❌ The guarantor substitution for *${label}* was rejected.\n\nReason: ${note}`,
  ).catch(() => undefined);
  await notifyMember(
    substitution.requestedBy,
    `❌ Your guarantor substitution on *${label}* was rejected.\n\nReason: ${note}\n` +
      `*${substitution.oldGuarantor.member.name}* remains the guarantor.`,
  ).catch(() => undefined);

  await audit({
    cooperativeId: substitution.cooperativeId,
    actorPhone: phone,
    actorId: admin.id,
    action: "guarantor.substitution.rejected",
    targetType: "loan",
    targetId: substitution.loanId,
    detail: `${substitution.reference}: ${note}`,
  }).catch(() => undefined);

  return { ok: true, message: `Substitution *${substitution.reference}* rejected.` };
}

export async function listSubstitutions(phone: string): Promise<GuarantorResult> {
  const admin = await adminActor(phone);
  if (!admin) return { ok: false, message: "Only an admin can list substitutions." };

  const rows = await prisma.guarantorSubstitution.findMany({
    where: {
      cooperativeId: admin.cooperativeId,
      status: { in: ["pending_guarantor", "pending_admin"] },
    },
    orderBy: { createdAt: "asc" },
    include: {
      newMember: { select: { name: true } },
      oldGuarantor: { include: { member: { select: { name: true } } } },
      loan: { select: { id: true, balance: true } },
    },
  });
  if (rows.length === 0) {
    return { ok: true, message: "No guarantor substitutions are waiting." };
  }
  const lines = [`🔄 *Pending guarantor substitutions* (${rows.length})`, ""];
  for (const row of rows) {
    lines.push(
      `• *${row.reference}* - ${row.oldGuarantor.member.name} → ${row.newMember.name}` +
        ` on ${loanLabel(row.loan.id)} (${formatBalance(row.loan.balance)}) - ${row.status === "pending_admin" ? "ready to approve" : "awaiting member confirmation"}`,
    );
  }
  return { ok: true, message: lines.join("\n") };
}
