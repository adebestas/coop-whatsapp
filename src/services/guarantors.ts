import { prisma } from "../lib/prisma.js";
import { generateGuarantorCode } from "../lib/security.js";
import { notifyMember } from "../lib/messaging.js";
import { formatBalance, getMemberByPhone } from "./cooperative.js";

export const REQUIRED_GUARANTORS = 2;
/** Admins and super admins only need one guarantor for their own loans. */
export function requiredGuarantors(borrowerRole?: string): number {
  return ["admin", "superadmin"].includes(borrowerRole ?? "") ? 1 : REQUIRED_GUARANTORS;
}
/** Once a cooperative reaches this many members, guarantors need 3+ months of membership. */
export const GUARANTOR_TENURE_THRESHOLD = 100;
const GUARANTOR_MIN_TENURE_MS = 3 * 30 * 24 * 60 * 60 * 1000;
/** A guarantor can't be on the hook for more than this multiple of their savings. */
export const GUARANTOR_EXPOSURE_RATIO = 2;
/** A member can only stand guarantor for this many active loans at once. */
export const GUARANTOR_MAX_ACTIVE = 2;

export interface GuarantorResult {
  ok: boolean;
  message: string;
}

/**
 * Add a guarantor to a loan by the guarantor's member code.
 * Auto-generates a unique confirmation code and sends it to the guarantor's
 * WhatsApp. The guarantor must reply `confirm <code>` to accept.
 */
export async function addGuarantor(phone: string, loanId: string, memberCode: string): Promise<GuarantorResult> {
  const member = await getMemberByPhone(phone);
  if (!member) return { ok: false, message: "You need to join a cooperative first." };

  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { guarantors: true, member: true },
  });
  if (!loan || loan.memberId !== member.id) {
    return { ok: false, message: "That loan doesn't belong to you." };
  }
  if (loan.status !== "pending") {
    return { ok: false, message: `This loan can no longer accept guarantors (status: ${loan.status}).` };
  }

  const normalized = memberCode.trim().toUpperCase();
  const guarantor = await prisma.member.findUnique({ where: { code: normalized } });
  if (!guarantor) {
    return { ok: false, message: `No member found with code *${normalized}*. Ask the member to reply *code* to see theirs.` };
  }
  if (guarantor.id === loan.memberId) {
    return { ok: false, message: "You can't be your own guarantor. Pick another member." };
  }
  if (loan.guarantors.some((g) => g.memberId === guarantor.id)) {
    return { ok: false, message: `*${guarantor.name}* is already a guarantor on this loan.` };
  }
  if (loan.guarantors.length >= requiredGuarantors(loan.member.role)) {
    return {
      ok: false,
      message: `This loan already has ${requiredGuarantors(loan.member.role)} guarantor(s).`,
    };
  }

  // A member can only stand guarantor for 2 active loans at a time.
  const activeCount = await prisma.guarantor.count({
    where: {
      memberId: guarantor.id,
      status: "confirmed",
      loan: { status: { in: ["guaranteed", "admin_approved", "approved", "disbursed"] } },
    },
  });
  if (activeCount >= GUARANTOR_MAX_ACTIVE) {
    return {
      ok: false,
      message: `*${guarantor.name}* is already guarantor for *${GUARANTOR_MAX_ACTIVE}* active loans. They can't take on another.`,
    };
  }

  // Scale-up rules kick in once the cooperative has 100+ members:
  // 1) guarantors need 3+ months of membership
  // 2) guarantees capped at 2x the guarantor's own savings
  const memberCount = await prisma.member.count({ where: { cooperativeId: member.cooperativeId } });
  if (memberCount >= GUARANTOR_TENURE_THRESHOLD) {
    const tenure = Date.now() - guarantor.createdAt.getTime();
    if (tenure < GUARANTOR_MIN_TENURE_MS) {
      return {
        ok: false,
        message: `*${guarantor.name}* joined less than 3 months ago. Cooperatives with *${GUARANTOR_TENURE_THRESHOLD}+ members* require guarantors with at least 3 months of membership.`,
      };
    }

    const guarantorWallet = await prisma.wallet.findUnique({ where: { memberId: guarantor.id } });
    const exposureLimit = Math.floor((guarantorWallet?.totalSaved ?? 0) * GUARANTOR_EXPOSURE_RATIO);
    const activeGuarantees = await prisma.guarantor.findMany({
      where: {
        memberId: guarantor.id,
        status: "confirmed",
        loan: { status: { in: ["guaranteed", "admin_approved", "approved", "disbursed"] } },
      },
      include: { loan: { select: { balance: true, amount: true } } },
    });
    const currentExposure = activeGuarantees.reduce(
      (sum, g) => sum + (g.loan.balance > 0 ? g.loan.balance : g.loan.amount),
      0,
    );
    if (currentExposure + loan.amount > exposureLimit) {
      return {
        ok: false,
        message:
          `*${guarantor.name}* can't guarantee this loan — guarantees are capped at *${GUARANTOR_EXPOSURE_RATIO}x savings*.\n` +
          `Their limit: ${formatBalance(exposureLimit)} (already guaranteeing ${formatBalance(currentExposure)}).`,
      };
    }
  }

  const code = await uniqueGuarantorCode();
  await prisma.guarantor.create({
    data: { loanId, memberId: guarantor.id, code, status: "pending" },
  });

  // Tell the guarantor they've been requested and how to accept.
  const requestText =
    `🔔 *Guarantor request*\n\n` +
    `*${loan.member.name}* has listed you as a guarantor for a loan of *₦${loan.amount.toLocaleString()}*.\n\n` +
    `To accept, reply with:\n*confirm ${code}*\n\n` +
    `Only accept if you trust this member — you're vouching for them.`;
  void notifyMember(guarantor, requestText).catch((err) =>
    console.error("[guarantor] failed to notify", err),
  );

  const remaining = requiredGuarantors(loan.member.role) - loan.guarantors.length - 1;
  return {
    ok: true,
    message:
      `✅ *${guarantor.name}* added as guarantor.\n\n` +
      `A confirmation code was sent to their WhatsApp. They must reply *confirm ${code}*.\n\n` +
      (remaining > 0
        ? `Add the other guarantor now — send their member code.`
        : `That's all the guarantors needed. The loan can be approved once they confirm.`),
  };
}

/** Member confirms they accept being a guarantor using their code. */
export async function confirmGuarantee(phone: string, code: string): Promise<GuarantorResult> {
  const normalized = code.trim().toUpperCase();
  const g = await prisma.guarantor.findUnique({
    where: { code: normalized },
    include: { member: true, loan: { include: { member: true, guarantors: true } } },
  });
  if (!g) {
    return { ok: false, message: `No guarantor request matches code *${normalized}*. Check and try again.` };
  }
  if (g.member.phone !== phone) {
    return { ok: false, message: "This confirmation code belongs to another member's WhatsApp." };
  }
  if (g.status === "confirmed") {
    return { ok: true, message: "You already confirmed this guarantee. ✅" };
  }
  if (g.status === "declined") {
    return { ok: false, message: "You declined this request earlier." };
  }

  await prisma.guarantor.update({
    where: { id: g.id },
    data: { status: "confirmed", confirmedAt: new Date() },
  });

  const loan = g.loan;
  const confirmedCount = await prisma.guarantor.count({
    where: { loanId: loan.id, status: "confirmed" },
  });
  const needed = requiredGuarantors(loan.member.role);

  // Once all required guarantors confirm, the loan becomes approvable.
  if (confirmedCount >= needed) {
    await prisma.loan.update({ where: { id: loan.id }, data: { status: "guaranteed" } });
  }

  return {
    ok: true,
    message:
      `✅ You've confirmed you're a guarantor for *${loan.member.name}*.\n\n` +
      (confirmedCount >= needed
        ? `All ${needed} guarantor(s) have confirmed. The loan is now *guaranteed* and ready for admin approval.`
        : `One more guarantor still needs to confirm before the loan can be approved.`),
  };
}

export async function getLoanWithGuarantors(loanId: string) {
  return prisma.loan.findUnique({
    where: { id: loanId },
    include: { guarantors: { include: { member: true } }, member: true },
  });
}

async function uniqueGuarantorCode(): Promise<string> {
  let code = generateGuarantorCode();
  while (await prisma.guarantor.findUnique({ where: { code } })) {
    code = generateGuarantorCode();
  }
  return code;
}