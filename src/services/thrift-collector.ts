import { prisma, withTx } from "../lib/prisma.js";
import { notifyMember } from "../lib/messaging.js";
import { formatBalance } from "./cooperative.js";
import { normalizePhone } from "../lib/phones.js";
import { recordLedger } from "./ledger.js";
import { audit } from "./audit.js";
import { getCoopId } from "../lib/runtime-context.js";

export interface CashCollectionResult {
  ok: boolean;
  message: string;
  reference?: string;
  newBalance?: number;
}

/** Check if the member has field collection authority. */
export function isCollectorOrAdmin(role: string | null | undefined): boolean {
  return ["collector", "admin", "superadmin"].includes(role ?? "");
}

/**
 * Record a physical cash deposit collected from a member by a field thrift collector / agent.
 * Immediately books into the member's wallet, records double-entry ledger entry,
 * and alerts the member instantly with receipt reference.
 */
export async function collectCashDeposit(
  collectorPhone: string,
  amountNaira: number,
  memberCodeOrPhone: string,
  note?: string,
): Promise<CashCollectionResult> {
  const actor = await prisma.member.findFirst({
    where: { phone: collectorPhone, ...(getCoopId() ? { cooperativeId: getCoopId() } : {}) },
  });

  if (!actor) {
    return { ok: false, message: "Collector account not found." };
  }

  if (!isCollectorOrAdmin(actor.role)) {
    return {
      ok: false,
      message:
        "Only authorized thrift collectors or cooperative admins can record physical cash collections.",
    };
  }

  const amountKobo = Math.round(amountNaira * 100);
  if (!Number.isFinite(amountKobo) || amountKobo <= 0) {
    return {
      ok: false,
      message:
        "Please specify a valid deposit amount: *collect <amount> <member code or phone> [note]*",
    };
  }

  const targetLookup = memberCodeOrPhone.trim();
  if (!targetLookup) {
    return {
      ok: false,
      message: "Please specify the member code or phone number to credit.",
    };
  }

  // Resolve member within collector's cooperative
  const normalizedPhone = normalizePhone(targetLookup);
  let target: {
    id: string;
    code: string;
    name: string;
    phone: string;
    contactPhone?: string | null;
    preferredPlatform?: string | null;
    optedOut?: boolean;
    cooperativeId: string;
    wallet: { id: string; balance: number; totalSaved: number } | null;
  } | null = null;

  if (normalizedPhone) {
    target = await prisma.member.findFirst({
      where: {
        cooperativeId: actor.cooperativeId,
        OR: [{ phone: normalizedPhone }, { contactPhone: normalizedPhone }],
      },
      include: { wallet: true },
    });
  }

  if (!target) {
    target = await prisma.member.findFirst({
      where: {
        cooperativeId: actor.cooperativeId,
        code: targetLookup.toUpperCase(),
      },
      include: { wallet: true },
    });
  }

  if (!target) {
    return {
      ok: false,
      message: `No active member found with code or phone *${targetLookup}* in your cooperative.`,
    };
  }

  const reference = `CASH-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const customNote = note?.trim() || `Field cash collection by agent ${actor.name}`;

  let newBalance: number;
  try {
    newBalance = await withTx(async (tx) => {
      const wallet =
        target!.wallet ??
        (await tx.wallet.create({
          data: { memberId: target!.id },
        }));

      await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          balance: { increment: amountKobo },
          totalSaved: { increment: amountKobo },
        },
      });

      await tx.contribution.create({
        data: {
          amount: amountKobo,
          type: "cash_collection",
          note: customNote,
          reference,
          status: "confirmed",
          paidAt: new Date(),
          memberId: target!.id,
          cooperativeId: actor.cooperativeId,
        },
      });

      await recordLedger({
        cooperativeId: actor.cooperativeId,
        type: "income",
        category: "savings",
        amount: amountKobo,
        note: `Field thrift collection from ${target!.name} (${target!.code}) by ${actor.name}`,
        reference,
        txRef: `cash_${reference.toLowerCase()}`,
        counterAccount: `member_wallet:${wallet.id}`,
        tx,
      });

      return wallet.balance + amountKobo;
    });
  } catch (err: any) {
    return {
      ok: false,
      message: `Failed to process cash collection: ${err?.message || "Internal database error"}`,
    };
  }

  // Audit the physical cash receipt
  await audit({
    cooperativeId: actor.cooperativeId,
    actorPhone: collectorPhone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "thrift.cash_collect",
    targetType: "member",
    targetId: target.id,
    amount: amountKobo,
    detail: `Thrift collector ${actor.name} collected ${formatBalance(amountKobo)} cash from ${target.name} (${target.code}). Ref: ${reference}`,
  });

  // Dual alert: Notify the member immediately on their preferred channel
  const memberAlert =
    `💵 *Cash Deposit Received*\n\n` +
    `Collector *${actor.name}* recorded a physical cash deposit of *${formatBalance(amountKobo)}* for your thrift savings.\n\n` +
    `• Receipt Ref: *${reference}*\n` +
    `• Note: ${customNote}\n` +
    `• New Savings Balance: *${formatBalance(newBalance)}*\n\n` +
    `Thank you for saving! 🛡️`;

  void notifyMember(target, memberAlert).catch((err) =>
    console.warn("[thrift-collector] failed to notify member of cash deposit:", err),
  );

  return {
    ok: true,
    reference,
    newBalance,
    message:
      `✅ *Cash Collected & Credited*\n\n` +
      `• Member: *${target.name}* (${target.code})\n` +
      `• Amount: *${formatBalance(amountKobo)}*\n` +
      `• Receipt: *${reference}*\n` +
      `• Member's New Balance: *${formatBalance(newBalance)}*\n\n` +
      `The deposit has been logged to cooperative ledger.`,
  };
}

/** Summarize all cash collections made by this collector today. */
export async function getCollectorDailySummary(collectorPhone: string): Promise<string> {
  const actor = await prisma.member.findFirst({
    where: { phone: collectorPhone, ...(getCoopId() ? { cooperativeId: getCoopId() } : {}) },
  });

  if (!actor || !isCollectorOrAdmin(actor.role)) {
    return "Only authorized thrift collectors or admins can access collection summaries.";
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const collections = await prisma.auditLog.findMany({
    where: {
      cooperativeId: actor.cooperativeId,
      actorId: actor.id,
      action: "thrift.cash_collect",
      createdAt: { gte: startOfDay },
    },
    orderBy: { createdAt: "desc" },
  });

  const totalKobo = collections.reduce((sum, item) => sum + (item.amount ?? 0), 0);

  let out = `📊 *Today's Cash Collection Summary*\n\n`;
  out += `• Collector: *${actor.name}*\n`;
  out += `• Total Entries: *${collections.length}*\n`;
  out += `• Total Cash Collected: *${formatBalance(totalKobo)}*\n\n`;

  if (collections.length === 0) {
    out += `No cash collections recorded yet today.`;
    return out;
  }

  out += `*Recent Collections Today:*\n`;
  collections.slice(0, 10).forEach((c, idx) => {
    const timeStr = c.createdAt.toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" });
    out += `${idx + 1}. [${timeStr}] ${formatBalance(c.amount ?? 0)} — ${c.detail || "Cash Deposit"}\n`;
  });

  return out;
}
