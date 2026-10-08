import { withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import { audit } from "./audit.js";
import { formatBalance } from "../lib/money.js";

const DEFAULT_REWARD_TYPE = "wallet";
const DEFAULT_REWARD_AMOUNT = 50000;

export interface ReferralResult {
  ok: boolean;
  message?: string;
}

export interface QualifyResult {
  ok: boolean;
  message?: string;
  referralId?: string;
}

interface RecordOutcome extends ReferralResult {
  created: boolean;
  referrerName?: string;
  referralId?: string;
}

interface QualifyOutcome extends QualifyResult {
  qualified: boolean;
  referrerId?: string;
  rewardType?: string;
  rewardAmount?: number;
}

/**
 * Record a member-get-member referral at join time. The referrer is resolved by
 * their member `code` within the cooperative; self-referral and unknown codes are
 * rejected (the join itself still succeeds — no referral is recorded). The new
 * row is `pending` until the referred member makes their first contribution.
 */
export async function recordReferral(
  coopId: string,
  referrerCode: string,
  referredMemberId: string,
): Promise<ReferralResult> {
  const raw = (referrerCode ?? "").trim();
  if (!raw) return { ok: false, message: "No referral code supplied." };

  let outcome: RecordOutcome;
  try {
    outcome = await withTx(async (tx) => {
      await setCoopContext(tx as never, coopId);
      const referrer = await tx.member.findFirst({
        where: {
          cooperativeId: coopId,
          code: { in: [raw, raw.toUpperCase(), raw.toLowerCase()] },
        },
        select: { id: true, name: true, code: true },
      });
      if (!referrer) {
        return { ok: false, created: false, message: `No member found with referral code *${raw}*.` };
      }
      if (referrer.id === referredMemberId) {
        return { ok: false, created: false, message: "You cannot refer yourself." };
      }
      const existing = await tx.referral.findUnique({ where: { referredMemberId } });
      if (existing) {
        return { ok: false, created: false, message: "A referral is already recorded for this member." };
      }
      const referral = await tx.referral.create({
        data: {
          cooperativeId: coopId,
          referrerId: referrer.id,
          referredMemberId,
          code: referrer.code,
          status: "pending",
        },
      });
      return { ok: true, created: true, referrerName: referrer.name, referralId: referral.id };
    });
  } catch {
    // A unique-constraint race on `referredMemberId` — another request recorded
    // the referral first. Treat it as a benign duplicate.
    return { ok: false, message: "A referral is already recorded for this member." };
  }

  if (outcome.created) {
    await audit({
      cooperativeId: coopId,
      actorPhone: "",
      actorId: referredMemberId,
      action: "referral.recorded",
      targetType: "referral",
      targetId: outcome.referralId,
      detail: `Referral recorded for ${outcome.referrerName ?? "referrer"}`,
    }).catch(() => {});
  }

  return { ok: outcome.ok, message: outcome.message };
}

/**
 * Qualify a referral on the referred member's first qualifying contribution.
 * Snapshots the coop's reward type + amount at this moment and flips the row to
 * `qualified`. Idempotent: a second call is a no-op and leaves the snapshot
 * untouched. The actual reward payment is handled separately (later task).
 */
export async function qualifyReferral(
  coopId: string,
  referredMemberId: string,
): Promise<QualifyResult> {
  const outcome = await withTx(async (tx): Promise<QualifyOutcome> => {
    await setCoopContext(tx as never, coopId);
    const referral = await tx.referral.findUnique({ where: { referredMemberId } });
    if (!referral || referral.cooperativeId !== coopId) {
      return { ok: false, qualified: false, message: "No referral to qualify." };
    }
    if (referral.status !== "pending") {
      return {
        ok: true,
        qualified: false,
        referralId: referral.id,
        message: "Referral already qualified.",
      };
    }

    const config = await tx.cooperativeConfig.findUnique({ where: { cooperativeId: coopId } });
    const rewardType = config?.referralRewardType ?? DEFAULT_REWARD_TYPE;
    const rewardAmount = config?.referralRewardAmount ?? DEFAULT_REWARD_AMOUNT;

    const claimed = await tx.referral.updateMany({
      where: { id: referral.id, status: "pending" },
      data: { status: "qualified", qualifiedAt: new Date(), rewardType, rewardAmount },
    });
    if (claimed.count === 0) {
      return {
        ok: true,
        qualified: false,
        referralId: referral.id,
        message: "Referral already qualified.",
      };
    }

    return {
      ok: true,
      qualified: true,
      referralId: referral.id,
      referrerId: referral.referrerId,
      rewardType,
      rewardAmount,
      message: `Referral qualified — *${formatBalance(rewardAmount)}* ${rewardType} reward pending.`,
    };
  });

  if (outcome.qualified) {
    await audit({
      cooperativeId: coopId,
      actorPhone: "",
      actorId: referredMemberId,
      action: "referral.qualified",
      targetType: "referral",
      targetId: outcome.referralId,
      amount: outcome.rewardAmount,
      detail: `${outcome.rewardType} reward of ${formatBalance(outcome.rewardAmount ?? 0)} for referrer ${outcome.referrerId}`,
    }).catch(() => {});
  }

  return { ok: outcome.ok, message: outcome.message, referralId: outcome.referralId };
}
