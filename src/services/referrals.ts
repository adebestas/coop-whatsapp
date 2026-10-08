import { withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import { audit } from "./audit.js";
import { postJournal } from "./journal.js";
import { sendToBank } from "./disbursements.js";
import { resolveVtuProvider } from "./payments/vtu.js";
import { enqueueAfterCommit } from "../lib/deferred.js";
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
    // paid. Inside a deferred-send scope (the top-up money-in path) the payment
    // is queued to run AFTER the credit transaction commits, so the provider
    // payout never executes with a DB transaction open. Outside any scope (the
    // deductions path) it runs immediately. Either way it is fail-safe: a
    // reward error is logged and audited, never propagated into the money-in
    // flow.
    if (outcome.referralId) {
      const pay = () => payReferralReward(coopId, outcome.referralId!);
      if (!enqueueAfterCommit(pay)) {
        await pay().catch((err) => {
          console.warn("[referral] reward payment failed:", err);
        });
      }
    }
  }

  return { ok: outcome.ok, message: outcome.message, referralId: outcome.referralId };
}

/** Thrown when a reward cannot be paid yet (e.g. airtime with no VTU provider). */
class RewardGatedError extends Error {}

type RewardReferrer = {
  id: string;
  name: string;
  phone: string;
  contactPhone: string | null;
  bankAccountNumber: string | null;
  bankCode: string | null;
  bankName: string | null;
} | null;

type RewardPrep =
  | { kind: "not_found" }
  | { kind: "not_qualified"; status: string }
  | {
      kind: "proceed";
      referralId: string;
      referrerId: string;
      rewardType: string;
      amount: number;
      referrer: RewardReferrer;
    };

/**
 * Pay the snapshotted reward for a referral that is currently `qualified`.
 *
 * Idempotent and safe under concurrency: an atomic `qualified → rewarded` claim
 * (inside the cooperative's RLS context) guarantees exactly one caller proceeds
 * to pay, and the wallet credit is further guarded by a deterministic journal
 * txRef. On a DEFINITE payment failure the referral is reverted to `qualified`
 * so a later retry can pay it — never stranded as `rewarded` without money
 * moving. An `unsure` payout (provider accepted but unconfirmed) is NOT
 * retryable: it stays `rewarded` and is audited for reconciliation.
 *
 * All DB work is self-contextualized (`withTx` + `setCoopContext`) so this is
 * correct when called standalone with no ambient context and under RLS-FORCE.
 * The provider bank payout itself runs OUTSIDE any transaction.
 *
 * Outcomes (never throws):
 *  - wallet      → credits the referrer's wallet (balanced journal) → `rewarded`
 *  - bank ok     → payout to the referrer's saved account           → `rewarded`
 *  - bank unsure → stays `rewarded`, audited for reconciliation    → no retry
 *  - bank failed / airtime gated / any error → stays `qualified`   → retryable
 */
export async function payReferralReward(
  coopId: string,
  referralId: string,
): Promise<{ ok: boolean; message: string }> {
  // Read + atomic claim + referrer lookup, all inside the coop RLS context.
  const prep = await withTx(async (tx): Promise<RewardPrep> => {
    await setCoopContext(tx as never, coopId);
    const referral = await tx.referral.findUnique({ where: { id: referralId } });
    if (!referral || referral.cooperativeId !== coopId) {
      return { kind: "not_found" };
    }
    if (referral.status !== "qualified") {
      return { kind: "not_qualified", status: referral.status };
    }
    const amount = referral.rewardAmount ?? 0;
    const rewardType = referral.rewardType ?? DEFAULT_REWARD_TYPE;
    if (amount <= 0) {
      return { kind: "not_qualified", status: "no-amount" };
    }
    const claimed = await tx.referral.updateMany({
      where: { id: referralId, status: "qualified" },
      data: { status: "rewarded", rewardedAt: new Date() },
    });
    if (claimed.count === 0) {
      return { kind: "not_qualified", status: "rewarded" };
    }
    const referrer = await tx.member.findUnique({
      where: { id: referral.referrerId },
      select: {
        id: true,
        name: true,
        phone: true,
        contactPhone: true,
        bankAccountNumber: true,
        bankCode: true,
        bankName: true,
      },
    });
    return {
      kind: "proceed",
      referralId,
      referrerId: referral.referrerId,
      rewardType,
      amount,
      referrer,
    };
  });

  if (prep.kind === "not_found") return { ok: false, message: "Referral not found." };
  if (prep.kind === "not_qualified") {
    return prep.status === "rewarded"
      ? { ok: true, message: "Referral reward already paid." }
      : { ok: false, message: `Referral is ${prep.status}; there is no reward to pay.` };
  }

  const { rewardType, amount, referrerId, referrer } = prep;
  let paidTo: string;
  try {
    if (rewardType === "wallet") {
      const name = await payWalletReward(coopId, referralId, referrerId, amount);
      paidTo = `${name}'s wallet`;
    } else if (rewardType === "bank") {
      if (!referrer) throw new Error("referrer no longer exists");
      if (!referrer.bankAccountNumber || !referrer.bankCode) {
        throw new Error("referrer has no saved bank account");
      }
      // Runs OUTSIDE any DB transaction (we are past the claim's `withTx`).
      const result = await sendToBank({
        memberId: referrer.id,
        amount,
        bankAccountNumber: referrer.bankAccountNumber,
        bankCode: referrer.bankCode,
        bankName: referrer.bankName ?? undefined,
        note: `Referral reward for ${referrer.name}`,
        idempotencyKey: `REFERRAL-${referralId}`,
      });
      if (!result.ok) {
        if (result.status === "unsure") {
          // The provider ACCEPTED the transfer but it is unconfirmed. A retry
          // could double-pay, so keep it `rewarded` and flag for reconciliation.
          await audit({
            cooperativeId: coopId,
            actorPhone: "",
            actorId: referrerId,
            action: "referral.reward.unconfirmed",
            targetType: "referral",
            targetId: referralId,
            amount,
            detail: `Referral reward of ${formatBalance(amount)} to ${referrer.name} was submitted but is UNCONFIRMED (${result.message}) — reconcile before any retry.`,
          }).catch(() => {});
          return {
            ok: true,
            message: `Referral reward submitted but UNCONFIRMED — it will be reconciled; do NOT retry.`,
          };
        }
        throw new Error(result.message);
      }
      paidTo = `${referrer.name}'s bank account`;
    } else if (rewardType === "airtime") {
      const provider = resolveVtuProvider();
      if (!provider) {
        throw new RewardGatedError(
          "Airtime reward not enabled yet — it will be paid automatically once a VTU provider is configured.",
        );
      }
      if (!referrer) throw new Error("referrer no longer exists");
      const phone = referrer.contactPhone ?? referrer.phone;
      const result = await provider.recharge({
        phone,
        amount,
        reference: `REFERRAL-${referralId}`,
      });
      if (!result.ok) throw new Error(result.error ?? "airtime recharge failed");
      paidTo = `${phone} (airtime)`;
    } else {
      throw new Error(`unknown reward type "${rewardType}"`);
    }
  } catch (err) {
    // A DEFINITE failure — revert so a later retry can pay it. Never leave the
    // referral stranded as `rewarded` when no money moved.
    await revertToQualified(coopId, referralId);
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
    actorId: referrerId,
    action: "referral.rewarded",
    targetType: "referral",
    targetId: referralId,
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
 * A duplicate is treated as an idempotent success (already credited). All reads
 * and writes run inside the cooperative's RLS context.
 */
async function payWalletReward(
  coopId: string,
  referralId: string,
  referrerId: string,
  amount: number,
): Promise<string> {
  try {
    return await withTx(async (tx) => {
      await setCoopContext(tx as never, coopId);
      const referrer = await tx.member.findUnique({
        where: { id: referrerId },
        include: { wallet: true },
      });
      if (!referrer) throw new Error("referrer no longer exists");
      if (!referrer.wallet) throw new Error("referrer has no wallet");

      const walletId = referrer.wallet.id;
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
      return referrer.name;
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      // Journal already posted — the wallet was credited on a prior attempt.
      const name = await withTx(async (tx) => {
        await setCoopContext(tx as never, coopId);
        const r = await tx.member.findUnique({ where: { id: referrerId }, select: { name: true } });
        return r?.name ?? "referrer";
      }).catch(() => "referrer");
      return name;
    }
    throw err;
  }
}

/** Revert a claimed reward that could not be paid, so a later retry can pay it. */
async function revertToQualified(coopId: string, referralId: string): Promise<void> {
  try {
    await withTx(async (tx) => {
      await setCoopContext(tx as never, coopId);
      await tx.referral.updateMany({
        where: { id: referralId, status: "rewarded" },
        data: { status: "qualified", rewardedAt: null },
      });
    });
  } catch {
    // best-effort revert — a later reconcile/retry can still repair the row
  }
}
