/**
 * Middleware wrapper for guaranteed enforcement of transaction limits.
 * Wraps any money operation with limit checks, velocity checks, and audit logging.
 */

import { LIMITS } from "./money.js";
import { checkVelocity, checkDailyPayoutLimit } from "../services/fraud.js";
import { audit } from "../services/audit.js";
import { formatBalance } from "./money.js";

export interface LimitsContext {
  memberId: string;
  memberPhone: string;
  memberRole?: string;
  cooperativeId: string;
  direction: "in" | "out";
  amount: number;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: string;
}

export interface LimitsResult<T> {
  ok: boolean;
  message?: string;
  data?: T;
}

/**
 * Enforce per-transaction limits based on direction.
 */
function checkPerTransactionLimits(direction: "in" | "out", amount: number): { ok: boolean; message?: string } {
  if (direction === "in") {
    if (amount < LIMITS.MIN_SAVE) {
      return { ok: false, message: `Minimum amount is *${formatBalance(LIMITS.MIN_SAVE)}*.` };
    }
    if (amount > LIMITS.MAX_SAVE) {
      return { ok: false, message: `Maximum amount is *${formatBalance(LIMITS.MAX_SAVE)}*.` };
    }
  } else {
    if (amount < LIMITS.MIN_WITHDRAW) {
      return { ok: false, message: `Minimum amount is *${formatBalance(LIMITS.MIN_WITHDRAW)}*.` };
    }
    if (amount > LIMITS.MAX_WITHDRAW) {
      return { ok: false, message: `Maximum amount is *${formatBalance(LIMITS.MAX_WITHDRAW)}*.` };
    }
  }
  return { ok: true };
}

/**
 * Wrap a money operation with all safety checks.
 *
 * Usage:
 *   const result = await withLimits(ctx, async () => {
 *     // perform the actual money operation
 *     return { success: true };
 *   });
 */
export async function withLimits<T>(
  ctx: LimitsContext,
  action: () => Promise<T>,
): Promise<LimitsResult<T>> {
  // 1. Per-transaction limits
  const limitsCheck = checkPerTransactionLimits(ctx.direction, ctx.amount);
  if (!limitsCheck.ok) {
    return { ok: false, message: limitsCheck.message };
  }

  // 2. Velocity check (money-out only)
  if (ctx.direction === "out") {
    if (!await checkVelocity(ctx.memberId)) {
      return {
        ok: false,
        message: "🛑 Too many transactions in a short period. Please wait a few minutes and try again.",
      };
    }

    // 3. Daily payout limit (money-out only)
    const dailyLimit = await checkDailyPayoutLimit(ctx.cooperativeId, ctx.amount);
    if (!dailyLimit.ok) {
      return { ok: false, message: dailyLimit.message };
    }
  }

  // 4. Execute the action
  try {
    const data = await action();

    // 5. Audit log
    await audit({
      cooperativeId: ctx.cooperativeId,
      actorPhone: ctx.memberPhone,
      actorId: ctx.memberId,
      actorRole: ctx.memberRole,
      action: ctx.action,
      targetType: ctx.targetType,
      targetId: ctx.targetId,
      amount: ctx.amount,
      detail: ctx.detail,
    });

    return { ok: true, data };
  } catch (err: any) {
    return {
      ok: false,
      message: `Transaction failed: ${String(err?.message ?? err).slice(0, 120)}`,
    };
  }
}
