import { prisma } from "../lib/prisma.js";
import { generateGuarantorCode } from "../lib/security.js";
import { sendText } from "../lib/whatsapp.js";
import { getMemberByPhone } from "./cooperative.js";

export const REQUIRED_GUARANTORS = 2;

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
  if (loan.guarantors.length >= REQUIRED_GUARANTORS) {
    return { ok: false, message: "This loan already has 2 guarantors." };
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
  void sendText({ to: guarantor.phone, text: requestText }).catch((err) =>
    console.error("[guarantor] failed to notify", err),
  );

  const remaining = REQUIRED_GUARANTORS - loan.guarantors.length - 1;
  return {
    ok: true,
    message:
      `✅ *${guarantor.name}* added as guarantor.\n\n` +
      `A confirmation code was sent to their WhatsApp. They must reply *confirm ${code}*.\n\n` +
      (remaining > 0
        ? `Add the second guarantor now — send their member code.`
        : `That's 2 guarantors. The loan can be approved once both confirm.`),
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

  // Once both guarantors confirm, the loan becomes approvable.
  if (confirmedCount >= REQUIRED_GUARANTORS) {
    await prisma.loan.update({ where: { id: loan.id }, data: { status: "guaranteed" } });
  }

  return {
    ok: true,
    message:
      `✅ You've confirmed you're a guarantor for *${loan.member.name}*.\n\n` +
      (confirmedCount >= REQUIRED_GUARANTORS
        ? `All 2 guarantors have confirmed. The loan is now *guaranteed* and ready for admin approval.`
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