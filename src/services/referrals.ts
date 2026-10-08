import { prisma, withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import { audit } from "./audit.js";
import { postJournal } from "./journal.js";
import { sendToBank } from "./disbursements.js";
import { resolveVtuProvider } from "./payments/vtu.js";
import { formatBalance } from "../lib/money.js";

const DEFAULT_REWARD_TYPE = "wallet";
const DEFAULT_REWARD_AMOUNT = 50000;
const INTERNAL_REWARD_ACCOUNT = "expense:referral_reward";

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
 * Snapshots the coop's reward type + amount at this moment, flips the row to
 * `qualified`, and pays the reward (wallet/bank/airtime) via
 * `payReferralReward`. Idempotent: a second call is a no-op and leaves the
 * snapshot untouched.
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

    // Single reward trigger: the referral we just moved pending → qualified is
    // paid immediately. Any payment failure leaves it `qualified` (retryable);
    // it never throws, so qualification always succeeds.
    if (outcome.referralId) {
      await payReferralReward(coopId, outcome.referralId).catch((err) => {
        console.warn("[referral] reward payment failed:", err);
      });
    }
  }

  return { ok: outcome.ok, message: outcome.message, referralId: outcome.referralId };
}

/** Thrown when a reward cannot be paid yet (e.g. airtime with no VTU provider). */
class RewardGatedError extends Error {}

/**
 * Pay the snapshotted reward for a referral that is currently `qualified`.
 *
 * Idempotent and safe under concurrency: an atomic `qualified → rewarded` claim
 * guarantees exactly one caller proceeds to pay, and the wallet credit is
 * further guarded by a deterministic journal txRef. On any payment failure the
 * referral is reverted to `qualified` so a later retry can pay it — it is never
 * left stranded as `rewarded` without money moving.
 *
 * Outcomes (never throws):
 *  - wallet  → credits the referrer's wallet (balanced journal) → `rewarded`
 *  - bank    → payout to the referrer's saved account        → `rewarded`
 *  - airtime → gated VTU adapter; unconfigured or any error  → stays `qualified`
 */
export async function payReferralReward(
  coopId: string,
  referralId: string,
): Promise<{ ok: boolean; message: string }> {
  const referral = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    return tx.referral.findUnique({ where: { id: referralId } });
  });
  if (!referral || referral.cooperativeId !== coopId) {
    return { ok: false, message: "Referral not found." };
  }
  if (referral.status === "rewarded") {
    return { ok: true, message: "Referral reward already paid." };
  }
  if (referral.status !== "qualified") {
    return { ok: false, message: `Referral is ${referral.status}; there is no reward to pay.` };
  }

  const amount = referral.rewardAmount ?? 0;
  const rewardType = referral.rewardType ?? DEFAULT_REWARD_TYPE;
  if (amount <= 0) {
    return { ok: false, message: "Referral reward amount is not set." };
  }

  // Atomic claim: exactly one caller moves qualified → rewarded and proceeds.
  const claimed = await prisma.referral.updateMany({
    where: { id: referralId, status: "qualified" },
    data: { status: "rewarded", rewardedAt: new Date() },
  });
  if (claimed.count === 0) {
    return { ok: true, message: "Referral reward already paid." };
  }

  let paidTo: string;
  try {
    if (rewardType === "wallet") {
      const name = await payWalletReward(coopId, referralId, referral.referrerId, amount);
      paidTo = `${name}'s wallet`;
    } else if (rewardType === "bank") {
      const referrer = await prisma.member.findUnique({ where: { id: referral.referrerId } });
      if (!referrer) throw new Error("referrer no longer exists");
      if (!referrer.bankAccountNumber || !referrer.bankCode) {
        throw new Error("referrer has no saved bank account");
      }
      const result = await sendToBank({
        memberId: referrer.id,
        amount,
        bankAccountNumber: referrer.bankAccountNumber,
        bankCode: referrer.bankCode,
        bankName: referrer.bankName ?? undefined,
        note: `Referral reward for ${referrer.name}`,
        idempotencyKey: `REFERRAL-${referral.id}`,
      });
      if (!result.ok) throw new Error(result.message);
      paidTo = `${referrer.name}'s bank account`;
    } else if (rewardType === "airtime") {
      const provider = resolveVtuProvider();
      if (!provider) {
        throw new RewardGatedError(
          "Airtime reward not enabled yet — it will be paid automatically once a VTU provider is configured.",
        );
      }
      const referrer = await prisma.member.findUnique({ where: { id: referral.referrerId } });
      if (!referrer) throw new Error("referrer no longer exists");
      const phone = referrer.contactPhone ?? referrer.phone;
      const result = await provider.recharge({
        phone,
        amount,
        reference: `REFERRAL-${referral.id}`,
      });
      if (!result.ok) throw new Error(result.error ?? "airtime recharge failed");
      paidTo = `${phone} (airtime)`;
    } else {
      throw new Error(`unknown reward type "${rewardType}"`);
    }
  } catch (err) {
    // Payment did not complete — revert so a later retry can pay it. Never
    // leave the referral stranded as `rewarded` when no money moved.
    await revertToQualified(referralId);
    if (err instanceof RewardGatedError) {
      return { ok: false, message: err.message };
    }
    return {
      ok: false,
      message: `Referral reward could not be paid: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  await audit({
    cooperativeId: coopId,
    actorPhone: "",
    actorId: referral.referrerId,
    action: "referral.rewarded",
    targetType: "referral",
    targetId: referral.id,
    amount,
    detail: `Paid ${formatBalance(amount)} ${rewardType} referral reward to ${paidTo}`,
  }).catch(() => {});

  return {
    ok: true,
    message: `✅ Referral reward of *${formatBalance(amount)}* paid to ${paidTo}.`,
  };
}

/**
 * Credit the referrer's wallet with a balanced journal entry. The journal txRef
 * is deterministic (`REFERRAL-<referralId>`) and `throwOnDuplicate` aborts the
 * whole transaction on a replay, so the wallet increment can never run twice.
 * A duplicate is treated as an idempotent success (already credited).
 */
async function payWalletReward(
  coopId: string,
  referralId: string,
  referrerId: string,
  amount: number,
): Promise<string> {
  const referrer = await prisma.member.findUnique({
    where: { id: referrerId },
    include: { wallet: true },
  });
  if (!referrer) throw new Error("referrer no longer exists");
  if (!referrer.wallet) throw new Error("referrer has no wallet");

  const walletId = referrer.wallet.id;
  try {
    await withTx(async (tx) => {
      await setCoopContext(tx as never, coopId);
      await postJournal(
        {
          cooperativeId: coopId,
          txRef: `REFERRAL-${referralId}`,
          description: `Referral reward for ${referrer.name} — ${formatBalance(amount)}`,
          postings: [
            { account: INTERNAL_REWARD_ACCOUNT, direction: "DEBIT", amount },
            {
              account: `member_wallet:${walletId}`,
              direction: "CREDIT",
              amount,
              memberId: referrerId,
            },
          ],
          throwOnDuplicate: true,
        },
        tx as never,
      );
      await tx.wallet.update({
        where: { id: walletId },
        data: { balance: { increment: amount } },
      });
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return referrer.name; // already credited
    throw err;
  }
  return referrer.name;
}

/** Revert a claimed reward that could not be paid, so a later retry can pay it. */
async function revertToQualified(referralId: string): Promise<void> {
  await prisma.referral
    .updateMany({
      where: { id: referralId, status: "rewarded" },
      data: { status: "qualified", rewardedAt: null },
    })
    .catch(() => {});
}
