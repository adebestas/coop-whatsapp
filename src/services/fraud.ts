import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";

/** Minimum gap between consecutive approvals of the same money-out request. */
export function approvalCooldownMs(): number {
  const raw = process.env.PAYMENT_COOLDOWN_MINUTES;
  const minutes = raw !== undefined && raw !== "" ? Number(raw) : process.env.NODE_ENV === "test" ? 0 : 5;
  return Math.max(0, minutes) * 60_000;
}

/**
 * Fraud guard: total money-out per cooperative per day may not exceed the
 * configured ceiling. Returns a warning string when close to the limit.
 */
export async function checkDailyPayoutLimit(
  cooperativeId: string,
  amount: number,
): Promise<{ ok: boolean; message?: string; warning?: string }> {
  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });
  const limit = coop?.dailyPayoutLimit ?? 1_000_000;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [payouts, withdrawals, externals] = await Promise.all([
    prisma.payout.aggregate({
      where: { cooperativeId, status: "successful", createdAt: { gte: startOfDay } },
      _sum: { amount: true },
    }),
    prisma.withdrawalRequest.aggregate({
      where: { cooperativeId, status: "paid", finalizedAt: { gte: startOfDay } },
      _sum: { amount: true },
    }),
    prisma.externalPayment.aggregate({
      where: { cooperativeId, status: "paid", updatedAt: { gte: startOfDay } },
      _sum: { amount: true },
    }),
  ]);

  const spentToday =
    (payouts._sum.amount ?? 0) + (withdrawals._sum.amount ?? 0) + (externals._sum.amount ?? 0);

  if (spentToday + amount > limit) {
    return {
      ok: false,
      message:
        `⛔ Daily payout ceiling reached: ${formatBalance(spentToday)} of ${formatBalance(limit)} already sent today. ` +
        `This payment would exceed it. A super admin can raise the ceiling.`,
    };
  }

  const afterPct = ((spentToday + amount) / limit) * 100;
  return {
    ok: true,
    warning:
      afterPct >= 80
        ? `⚠️ Daily payouts at ${Math.round(afterPct)}% of the ${formatBalance(limit)} ceiling.`
        : undefined,
  };
}

// ---- Chat command rate limiting (per phone, money commands) ----
const moneyCommandLog = new Map<string, number[]>();
const MONEY_WINDOW_MS = 60 * 60 * 1000;
const MONEY_MAX_PER_HOUR = 6;

export function checkMoneyRateLimit(phone: string): boolean {
  const now = Date.now();
  const stamps = (moneyCommandLog.get(phone) ?? []).filter((t) => now - t < MONEY_WINDOW_MS);
  if (stamps.length >= MONEY_MAX_PER_HOUR) return false;
  stamps.push(now);
  moneyCommandLog.set(phone, stamps);
  return true;
}
