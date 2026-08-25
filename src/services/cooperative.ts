import { prisma } from "../lib/prisma.js";
import { generateMemberCode, hashPin } from "../lib/security.js";
import { audit } from "./audit.js";
import { LIMITS } from "../lib/money.js";
import { formatBalance as formatKobo } from "../lib/money.js";
import { getCoopConfig } from "./coop-config.js";

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
  email?: string,
  dateOfBirth?: Date,
  nextOfKin?: { name: string; phone: string },
  phoneVerified = false,
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

  // Platform lock: one account per person per cooperative. A member who
  // started on WhatsApp can't open a second account on Telegram (or
  // vice-versa) — transactions must be finished where they were started.
  const realPhone = contactPhone ?? (phone.startsWith("tg:") ? null : phone);
  if (realPhone) {
    const twin = await prisma.member.findFirst({
      where: {
        cooperativeId: coop.id,
        contactPhone: realPhone,
        NOT: [{ phone }],
      },
    });
    if (twin) {
      const platform = twin.phone.startsWith("tg:") ? "Telegram" : "WhatsApp";
      const newPlatform = phone.startsWith("tg:") ? "Telegram" : "WhatsApp";
      // Same human, second platform: link it as an alerts-only channel.
      // Notifications follow their most-used app; accounts stay singular so
      // transactions always happen in one place.
      await prisma.member.update({
        where: { id: twin.id },
        data: { altChannelId: phone },
      });
      return {
        ok: true,
        memberId: twin.id,
        message:
          `Welcome back, *${twin.name}*! Your account lives on *${platform}* — ` +
          `this *${newPlatform}* chat will now receive your alerts.\n\n` +
          `For saving, loans and withdrawals, keep using *${platform}*.`,
      };
    }
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
      contactPhone: realPhone,
      email,
      dateOfBirth,
      nextOfKinName: nextOfKin?.name,
      nextOfKinPhone: nextOfKin?.phone,
      phoneVerified,
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
  const naira = balance / 100;
  return `${currency} ${naira.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  const coopConfig = await getCoopConfig(member.cooperativeId);
  if (amount < coopConfig.minContribution) {
    return { ok: false, message: `Minimum save amount is *${formatKobo(coopConfig.minContribution)}*.` };
  }
  if (amount > LIMITS.MAX_SAVE) {
    return { ok: false, message: `Maximum save amount is *${formatKobo(LIMITS.MAX_SAVE)}*.` };
  }

  const reference = `CON-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  // ✅ Wrapped in transaction — both succeed or both fail (prevents money loss)
  await prisma.$transaction([
    prisma.contribution.create({
      data: {
        amount,
        reference,
        status: "confirmed",
        paidAt: new Date(),
        memberId: member.id,
        cooperativeId: member.cooperativeId,
      },
    }),
    prisma.wallet.update({
      where: { id: member.wallet.id },
      data: {
        balance: { increment: amount },
        totalSaved: { increment: amount },
      },
    }),
  ]);

  const balanceBefore = member.wallet.balance ?? 0;
  const balance = balanceBefore + amount;
  await audit({
    cooperativeId: member.cooperativeId,
    actorPhone: phone,
    actorId: member.id,
    actorRole: member.role,
    action: "contribution.create",
    targetType: "contribution",
    amount,
    balanceBefore,
    balanceAfter: balance,
    detail: formatBalance(amount),
  });
  return {
    ok: true,
    message: `✅ Saved ${formatBalance(amount)}.\nYour new balance is *${formatBalance(balance)}*.\n\nReply *balance* anytime to check.`,
  };
}

export async function createCooperative(data: { name: string; code: string; adminPhone?: string; state?: string }) {
  return prisma.cooperative.create({ data });
}