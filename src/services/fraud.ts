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
 * configured ceiling. Also enforces an optional PILOT_FLOAT_CAP — a hard
 * ceiling on total money-out this calendar month, meant for the pilot period
 * (set PILOT_FLOAT_CAP=500000 in .env; unset/0 disables). Returns a warning
 * string when close to the limit.
 */
export async function checkDailyPayoutLimit(
  cooperativeId: string,
  amount: number,
): Promise<{ ok: boolean; message?: string; warning?: string }> {
  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });
  const limit = coop?.dailyPayoutLimit ?? 1_000_000;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(startOfDay.getFullYear(), startOfDay.getMonth(), 1);

  const [payouts, withdrawals, externals, monthPayouts] = await Promise.all([
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
    prisma.payout.aggregate({
      where: { cooperativeId, status: "successful", createdAt: { gte: startOfMonth } },
      _sum: { amount: true },
    }),
  ]);

  const spentToday =
    (payouts._sum.amount ?? 0) + (withdrawals._sum.amount ?? 0) + (externals._sum.amount ?? 0);

  if (spentToday + amount > limit) {
    return {
      ok: false,
      message:
        `🛑 Daily payout ceiling reached: ${formatBalance(spentToday)} of ${formatBalance(limit)} already sent today. ` +
        `This payment would exceed it. A super admin can raise the ceiling.`,
    };
  }

  // Pilot float cap — total out this month.
  const floatCap = Number(process.env.PILOT_FLOAT_CAP ?? 0);
  if (floatCap > 0 && (monthPayouts._sum.amount ?? 0) + amount > floatCap) {
    return {
      ok: false,
      message:
        `🧪 Pilot safety cap reached: ${formatBalance(monthPayouts._sum.amount ?? 0)} has gone out this month and the pilot ceiling is ${formatBalance(floatCap)}. ` +
        `Raise or remove PILOT_FLOAT_CAP once you're confident in live operations.`,
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

/** Test hook: clear the in-memory money-command log. */
export function resetMoneyRateLimit(): void {
  moneyCommandLog.clear();
}

// ---- Transaction velocity (per member, money-out) ----
const velocityLog = new Map<string, number[]>();
const VELOCITY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const VELOCITY_MAX = 5; // max 5 money-out per window

/**
 * Check if a member has exceeded the velocity limit for money-out transactions.
 * Returns true if the transaction is allowed, false if blocked.
 */
export function checkVelocity(memberId: string): boolean {
  const now = Date.now();
  const timestamps = (velocityLog.get(memberId) ?? []).filter((t) => now - t < VELOCITY_WINDOW_MS);
  if (timestamps.length >= VELOCITY_MAX) return false;
  timestamps.push(now);
  velocityLog.set(memberId, timestamps);
  return true;
}

/** Test hook: clear the in-memory velocity log. */
export function resetVelocity(): void {
  velocityLog.clear();
}
