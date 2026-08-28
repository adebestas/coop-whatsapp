import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { getRedis } from "../lib/cache.js";

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

  // Always aggregate fresh from the database. We deliberately do NOT cache
  // running totals in Redis here: a cached aggregate would go stale as soon
  // as a payout succeeds, letting subsequent money-out exceed the configured
  // daily/monthly ceiling (a fraud-control bypass). The few extra reads are
  // cheap relative to the money-out write path this guards.
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
  const monthTotal = monthPayouts._sum.amount ?? 0;

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
  if (floatCap > 0 && monthTotal + amount > floatCap) {
    return {
      ok: false,
      message:
        `🧪 Pilot safety cap reached: ${formatBalance(monthTotal)} has gone out this month and the pilot ceiling is ${formatBalance(floatCap)}. ` +
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
// Uses Redis when available; falls back to per-key in-memory tracking.
const MONEY_WINDOW_SECONDS = 60 * 60; // 1 hour
const MONEY_MAX_PER_HOUR = 6;
const moneyInMemory = new Map<string, { count: number; resetAt: number }>();

// Sweep expired entries every 60 seconds to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of moneyInMemory) {
    if (now > entry.resetAt) moneyInMemory.delete(key);
  }
}, 60_000).unref();

export async function checkMoneyRateLimit(phone: string): Promise<boolean> {
  const key = `money:${phone}`;
  const client = getRedis();
  if (client) {
    try {
      const redisKey = `rl:${key}`;
      const current = await client.incr(redisKey);
      await client.expire(redisKey, MONEY_WINDOW_SECONDS); // Always set — idempotent
      return current <= MONEY_MAX_PER_HOUR;
    } catch { /* fall through */ }
  }
  // In-memory fallback
  const now = Date.now();
  const entry = moneyInMemory.get(key);
  if (!entry || now > entry.resetAt) {
    moneyInMemory.set(key, { count: 1, resetAt: now + MONEY_WINDOW_SECONDS * 1000 });
    return true;
  }
  if (entry.count >= MONEY_MAX_PER_HOUR) return false;
  entry.count++;
  // Periodic cleanup of expired entries
  if (moneyInMemory.size > 1000) {
    for (const [k, v] of moneyInMemory) {
      if (now > v.resetAt) moneyInMemory.delete(k);
    }
  }
  return true;
}

/** Test hook: clear all money rate limit state. */
export async function resetMoneyRateLimit(): Promise<void> {
  moneyInMemory.clear();
}

// ---- Transaction velocity (per member, money-out) ----
// Uses Redis when available; falls back to per-key in-memory tracking.
const VELOCITY_WINDOW_SECONDS = 10 * 60; // 10 minutes
const VELOCITY_MAX = 5;
const velocityInMemory = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of velocityInMemory) {
    if (now > entry.resetAt) velocityInMemory.delete(key);
  }
}, 60_000).unref();

export async function checkVelocity(memberId: string): Promise<boolean> {
  const key = `velocity:${memberId}`;
  const client = getRedis();
  if (client) {
    try {
      const redisKey = `rl:${key}`;
      const current = await client.incr(redisKey);
      await client.expire(redisKey, VELOCITY_WINDOW_SECONDS); // Always set — idempotent
      return current <= VELOCITY_MAX;
    } catch { /* fall through */ }
  }
  const now = Date.now();
  const entry = velocityInMemory.get(key);
  if (!entry || now > entry.resetAt) {
    velocityInMemory.set(key, { count: 1, resetAt: now + VELOCITY_WINDOW_SECONDS * 1000 });
    return true;
  }
  if (entry.count >= VELOCITY_MAX) return false;
  entry.count++;
  // Periodic cleanup of expired entries
  if (velocityInMemory.size > 1000) {
    for (const [k, v] of velocityInMemory) {
      if (now > v.resetAt) velocityInMemory.delete(k);
    }
  }
  return true;
}

/** Test hook: clear velocity state. */
export async function resetVelocity(): Promise<void> {
  velocityInMemory.clear();
}

// ---- AI query rate limiting (per member, per hour) ----
// Uses Redis when available; falls back to per-key in-memory tracking.
const AI_QUERY_WINDOW_SECONDS = 60 * 60; // 1 hour
const AI_QUERY_MAX_PER_HOUR = 10;
const aiInMemory = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of aiInMemory) {
    if (now > entry.resetAt) aiInMemory.delete(key);
  }
}, 60_000).unref();

export async function checkAIRateLimit(memberId: string): Promise<boolean> {
  const key = `ai:${memberId}`;
  const client = getRedis();
  if (client) {
    try {
      const redisKey = `rl:${key}`;
      const current = await client.incr(redisKey);
      await client.expire(redisKey, AI_QUERY_WINDOW_SECONDS); // Always set — idempotent
      return current <= AI_QUERY_MAX_PER_HOUR;
    } catch { /* fall through */ }
  }
  const now = Date.now();
  const entry = aiInMemory.get(key);
  if (!entry || now > entry.resetAt) {
    aiInMemory.set(key, { count: 1, resetAt: now + AI_QUERY_WINDOW_SECONDS * 1000 });
    return true;
  }
  if (entry.count >= AI_QUERY_MAX_PER_HOUR) return false;
  entry.count++;
  // Periodic cleanup of expired entries
  if (aiInMemory.size > 1000) {
    for (const [k, v] of aiInMemory) {
      if (now > v.resetAt) aiInMemory.delete(k);
    }
  }
  return true;
}

/** Test hook: clear AI query rate limit state. */
export async function resetAIRateLimit(): Promise<void> {
  aiInMemory.clear();
}
