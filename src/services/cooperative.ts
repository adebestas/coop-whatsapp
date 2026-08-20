import { prisma } from "../lib/prisma.js";
import { generateMemberCode, hashPin } from "../lib/security.js";

export interface JoinResult {
  ok: boolean;
  message: string;
  memberId?: string;
}

/**
 * Find an existing member by cooperative code + phone, or create them.
 */
export async function findOrCreateMember(
  phone: string,
  coopCode: string,
  name: string,
  pin: string,
  contactPhone?: string,
): Promise<JoinResult> {
  const coop = await prisma.cooperative.findUnique({ where: { code: coopCode } });
  if (!coop) {
    return { ok: false, message: `We couldn't find a cooperative with code *${coopCode}*. Check the code and try again.` };
  }

  const existing = await prisma.member.findUnique({
    where: { cooperativeId_phone: { cooperativeId: coop.id, phone } },
  });
  if (existing) {
    return { ok: false, message: `You're already a member of *${coop.name}*. Reply *menu* to see what you can do.` };
  }

  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }

  const member = await prisma.member.create({
    data: {
      phone,
      // WhatsApp members are identified by their number already; only
      // Telegram users need a separately-collected real phone.
      contactPhone: contactPhone ?? (phone.startsWith("tg:") ? null : phone),
      name,
      code,
      pin: hashPin(pin),
      cooperativeId: coop.id,
      wallet: { create: {} },
    },
  });

  return {
    ok: true,
    memberId: member.id,
    message: `Welcome, *${name}*! You're now a member of *${coop.name}*.\n\nYour member code is *${code}* — you'll share this with friends who need you as a guarantor.\n\nReply *menu* to see what you can do, or type *save 2000* to make your first contribution.`,
  };
}

export async function getMemberByPhone(phone: string) {
  return prisma.member.findFirst({
    where: { phone },
    include: { cooperative: true, wallet: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function getCoopByCode(code: string) {
  return prisma.cooperative.findUnique({ where: { code } });
}

export function formatBalance(balance: number, currency = "NGN"): string {
  return `${currency} ${balance.toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
}

export async function createContribution(phone: string, amount: number): Promise<{ ok: boolean; message: string }> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>* to get started." };
  }
  if (!member.wallet) {
    return { ok: false, message: "No wallet found. Please contact your cooperative admin." };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Please enter a valid amount, e.g. *save 2000*." };
  }

  const reference = `CON-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await prisma.contribution.create({
    data: {
      amount,
      reference,
      status: "confirmed",
      paidAt: new Date(),
      memberId: member.id,
      cooperativeId: member.cooperativeId,
    },
  });

  await prisma.wallet.update({
    where: { id: member.wallet.id },
    data: {
      balance: { increment: amount },
      totalSaved: { increment: amount },
    },
  });

  const balance = (member.wallet.balance ?? 0) + amount;
  return {
    ok: true,
    message: `✅ Saved ${formatBalance(amount)}.\nYour new balance is *${formatBalance(balance)}*.\n\nReply *balance* anytime to check.`,
  };
}

export async function createCooperative(data: { name: string; code: string; adminPhone?: string; state?: string }) {
  return prisma.cooperative.create({ data });
}