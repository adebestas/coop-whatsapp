import { prisma } from "../lib/prisma.js";
import { hashPin } from "../lib/security.js";
import { audit } from "./audit.js";
import { LIMITS, formatBalance } from "../lib/money.js";
import { getCoopConfig } from "./coop-config.js";

export { formatBalance } from "../lib/money.js";

export interface JoinResult {
  ok: boolean;
  message: string;
  memberId?: string;
}

/**
 * Generate a human-friendly, globally-unique member file number.
 *
 * Format: `{COOP}/{YYY}/{MM}/{SEQ}` — e.g. `SC/026/08/081`
 *   - COOP = cooperative join code, uppercased (e.g. SC)
 *   - YYY  = last 3 digits of the join year, zero-padded (2026 -> 026)
 *   - MM   = join month, zero-padded (August -> 08)
 *   - SEQ  = atomic running per-coop sequence (081 = 81st member of this coop)
 *
 * The sequence is incremented atomically on the Cooperative row
 * (`memberSeq`), so it never collides even under concurrent registration.
 */
export async function generateMemberFileNumber(
  cooperativeId: string,
  coopCode: string,
  joinedAt: Date = new Date(),
): Promise<string> {
  const prefix = coopCode.trim().toUpperCase();
  const yy = String(joinedAt.getUTCFullYear() % 1000).padStart(3, "0");
  const mm = String(joinedAt.getUTCMonth() + 1).padStart(2, "0");
  const { memberSeq } = await prisma.cooperative.update({
    where: { id: cooperativeId },
    data: { memberSeq: { increment: 1 } },
    select: { memberSeq: true },
  });
  return `${prefix}/${yy}/${mm}/${String(memberSeq).padStart(3, "0")}`;
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

  const code = await generateMemberFileNumber(coop.id, coop.code);

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

const memberCache = new Map<string, { data: any; expires: number }>();
const CACHE_TTL = 30_000;

export async function getMemberByPhone(phone: string) {
  const cached = memberCache.get(phone);
  if (cached && Date.now() < cached.expires) return cached.data;
  const member = await prisma.member.findFirst({
    where: { phone },
    include: { cooperative: true, wallet: true },
    orderBy: { createdAt: "asc" },
  });
  if (member) memberCache.set(phone, { data: member, expires: Date.now() + CACHE_TTL });
  return member;
}

/**
 * TEST-ONLY helper — DO NOT call from any production/flux path.
 *
 * This fabricates a wallet credit with NO real payment (no Monnify/Paystack).
 * The only legitimate money-in path is topup.ts handlePaymentNotification via a
 * provider webhook. Kept only so tests can pre-fund wallets when setting up
 * unrelated scenarios. Any production code that wants to credit a wallet must
 * go through a verified payment — never through this function.
 */
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
    return { ok: false, message: `Minimum save amount is *${formatBalance(coopConfig.minContribution)}*.` };
  }
  if (amount > LIMITS.MAX_SAVE) {
    return { ok: false, message: `Maximum save amount is *${formatBalance(LIMITS.MAX_SAVE)}*.` };
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

export async function createCooperative(data: {
  name: string;
  code: string;
  adminPhone?: string;
  state?: string;
  registrationNumber?: string;
}) {
  if (!data.registrationNumber) {
    console.warn(`[compliance] Cooperative "${data.name}" created without a registration number. Registration number is required under CAMA for legal recognition.`);
  }
  return prisma.cooperative.create({ data });
}