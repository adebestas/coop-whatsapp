import { withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import { audit } from "./audit.js";
import { postJournal } from "./journal.js";
import { sendToBank } from "./disbursements.js";
import { resolveVtuProvider } from "./payments/vtu.js";
import { formatBalance } from "../lib/money.js";
import { log } from "../lib/logger.js";

const DEFAULT_REWARD_TYPE = "wallet";
const DEFAULT_REWARD_AMOUNT = 50000;
/** The internal account referral bonuses are drawn from (kobo, double-entry). */
const INTERNAL_REWARD_ACCOUNT = "expense:referral_reward";
/** Valid withdrawal destinations (no Prisma enum — plain strings). */
const WITHDRAWAL_DESTINATIONS = new Set(["wallet", "bank", "airtime"]);

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
  rejected?: boolean;
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
      // The program is opt-in per cooperative. When it is off (or paused by the
      // Board) the join still succeeds — we simply do not record a referral.
      const gate = await tx.cooperativeConfig.findUnique({
        where: { cooperativeId: coopId },
        select: { referralEnabled: true },
      });
      if (gate?.referralEnabled !== true) {
        return {
          ok: false,
          created: false,
          message: "Referrals are not enabled for this cooperative.",
        };
      }
      const referrer = await tx.member.findFirst({
        where: {
          cooperativeId: coopId,
          code: { in: [raw, raw.toUpperCase(), raw.toLowerCase()] },
        },
        select: { id: true, name: true, code: true },
      });
      if (!referrer) {
        return {
          ok: false,
          created: false,
          message: `No member found with referral code *${raw}*.`,
        };
      }
      if (referrer.id === referredMemberId) {
        return { ok: false, created: false, message: "You cannot refer yourself." };
      }
      const existing = await tx.referral.findUnique({ where: { referredMemberId } });
      if (existing) {
        return {
          ok: false,
          created: false,
          message: "A referral is already recorded for this member.",
        };
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
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      // A unique-constraint race on `referredMemberId` — another request recorded
      // the referral first. Treat it as a benign duplicate.
      return { ok: false, message: "A referral is already recorded for this member." };
    }
    // Any other failure is a REAL fault (DB/connection), not a duplicate. The
    // join still succeeds (the caller swallows), but never report it as one.
    log.error("[referral] failed to record referral", { coopId, err: String(err) });
    return { ok: false, message: "Referral could not be recorded right now." };
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
 * Snapshots the coop's reward type + amount, credits the referrer's
 * `referralBonusBalance` by that amount, and marks the row `rewarded`. The bonus
 * is a running balance the referrer later withdraws (see `withdrawReferralBonus`),
 * so qualification makes no provider call. Idempotent: a second call is a no-op
 * and leaves the snapshot + balance untouched.
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
    if (config?.referralEnabled !== true) {
      return {
        ok: false,
        qualified: false,
        referralId: referral.id,
        message: "Referrals are not enabled for this cooperative.",
      };
    }
    const rewardType = config?.referralRewardType ?? DEFAULT_REWARD_TYPE;
    const rewardAmount = config?.referralRewardAmount ?? DEFAULT_REWARD_AMOUNT;

    // Per-referrer cap: count the rewards this referrer has already earned. At
    // the cap the referral is rejected (not left pending) so it is not retried
    // on every later contribution.
    const maxRewards = config?.referralMaxRewards ?? 0;
    if (maxRewards > 0) {
      const earned = await tx.referral.count({
        where: {
          cooperativeId: coopId,
          referrerId: referral.referrerId,
          status: { in: ["qualified", "rewarded"] },
        },
      });
      if (earned >= maxRewards) {
        const claimed = await tx.referral.updateMany({
          where: { id: referral.id, status: "pending" },
          data: { status: "rejected" },
        });
        return {
          ok: false,
          qualified: false,
          rejected: claimed.count > 0,
          referralId: referral.id,
          message: `Referral not qualified — the referrer has reached their reward cap (${maxRewards}).`,
        };
      }
    }

    const claimed = await tx.referral.updateMany({
      where: { id: referral.id, status: "pending" },
      data: { status: "rewarded", qualifiedAt: new Date(), rewardType, rewardAmount },
    });
    if (claimed.count === 0) {
      return {
        ok: true,
        qualified: false,
        referralId: referral.id,
        message: "Referral already qualified.",
      };
    }

    // Grant the bonus in the SAME transaction as the claim — credit the
    // referrer's running bonus balance. No provider call: the member later
    // withdraws from this balance.
    await tx.member.update({
      where: { id: referral.referrerId },
      data: { referralBonusBalance: { increment: rewardAmount } },
    });

    return {
      ok: true,
      qualified: true,
      referralId: referral.id,
      referrerId: referral.referrerId,
      rewardType,
      rewardAmount,
      message: `Referral qualified — *${formatBalance(rewardAmount)}* credited to the referrer's bonus balance.`,
    };
  });

  if (outcome.qualified) {
    await audit({
      cooperativeId: coopId,
      actorPhone: "",
      actorId: referredMemberId,
      action: "referral.bonus.credited",
      targetType: "referral",
      targetId: outcome.referralId,
      amount: outcome.rewardAmount,
      detail: `Credited ${formatBalance(outcome.rewardAmount ?? 0)} referral bonus for referrer ${outcome.referrerId}`,
    }).catch(() => {});
  }

  if (outcome.rejected && outcome.referralId) {
    await audit({
      cooperativeId: coopId,
      actorPhone: "",
      actorId: referredMemberId,
      action: "referral.rejected",
      targetType: "referral",
      targetId: outcome.referralId,
      detail: "Referral rejected — the referrer has reached their reward cap",
    }).catch(() => {});
  }

  return { ok: outcome.ok, message: outcome.message, referralId: outcome.referralId };
}

/** Valid `referralRewardType` values (no Prisma enum — plain strings). */
const REWARD_TYPES = new Set(["wallet", "bank", "airtime"]);

function statusLabel(status: string): string {
  switch (status) {
    case "qualified":
      return "✅ qualified (reward pending)";
    case "rewarded":
      return "💸 reward paid";
    case "rejected":
      return "⛔ rejected";
    default:
      return "⏳ pending";
  }
}

/**
 * The member's own referral programme view: everyone they referred, the status
 * of each, and how much they have earned. RLS-safe (`withTx` + `setCoopContext`).
 */
export async function myReferrals(
  coopId: string,
  memberId: string,
): Promise<{ ok: boolean; message: string }> {
  const rows = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    return tx.referral.findMany({
      where: { cooperativeId: coopId, referrerId: memberId },
      orderBy: { createdAt: "desc" },
      include: { referredMember: { select: { name: true } } },
    });
  });

  if (rows.length === 0) {
    return {
      ok: true,
      message:
        "You haven't referred anyone yet. Share your referral code — reply *myrefcode* to get it.",
    };
  }

  const qualified = rows.filter((r) => r.status === "qualified" || r.status === "rewarded").length;
  const rewarded = rows.filter((r) => r.status === "rewarded").length;
  const earned = rows
    .filter((r) => r.status === "rewarded")
    .reduce((sum, r) => sum + (r.rewardAmount ?? 0), 0);

  const lines = rows
    .map((r) => {
      const amount =
        r.status === "rewarded" && r.rewardAmount ? ` (${formatBalance(r.rewardAmount)})` : "";
      return `• ${r.referredMember?.name ?? "A member"} — ${statusLabel(r.status)}${amount}`;
    })
    .join("\n");

  return {
    ok: true,
    message:
      `📣 *Your referrals*\n\n` +
      `Referred: *${rows.length}* · Qualified: *${qualified}* · Rewards paid: *${rewarded}*\n` +
      `Earned: *${formatBalance(earned)}*\n\n` +
      `${lines}\n\n` +
      `Share your code — reply *myrefcode*.`,
  };
}

/**
 * Create or update a cooperative's referral configuration and audit the change.
 * The program is opt-in: `enabled` must be set to `true` for referrals to be
 * recorded or rewards to be paid. Coop-scoped write via `withTx` +
 * `setCoopContext`, audited as `referral.config`.
 */
export async function setReferralConfig(
  coopId: string,
  input: {
    enabled?: boolean;
    rewardType?: string;
    rewardAmount?: number;
    maxRewards?: number;
  },
  actor: { id: string; phone: string; role?: string },
): Promise<{ ok: boolean; message: string }> {
  const type = input.rewardType?.trim().toLowerCase();
  if (type && !REWARD_TYPES.has(type)) {
    return {
      ok: false,
      message: `Unknown reward type *${input.rewardType}*. Use *wallet*, *bank* or *airtime*.`,
    };
  }
  if (
    input.rewardAmount !== undefined &&
    (!Number.isInteger(input.rewardAmount) || input.rewardAmount <= 0)
  ) {
    return { ok: false, message: "Reward amount must be a positive amount (kobo)." };
  }
  if (
    input.maxRewards !== undefined &&
    (!Number.isInteger(input.maxRewards) || input.maxRewards < 0)
  ) {
    return { ok: false, message: "Max rewards must be 0 (unlimited) or a positive whole number." };
  }

  const data = {
    ...(input.enabled !== undefined ? { referralEnabled: input.enabled } : {}),
    ...(type ? { referralRewardType: type } : {}),
    ...(input.rewardAmount !== undefined ? { referralRewardAmount: input.rewardAmount } : {}),
    ...(input.maxRewards !== undefined ? { referralMaxRewards: input.maxRewards } : {}),
  };

  const config = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    return tx.cooperativeConfig.upsert({
      where: { cooperativeId: coopId },
      create: { cooperativeId: coopId, ...data },
      update: data,
    });
  });

  const cap = config.referralMaxRewards === 0 ? "unlimited" : String(config.referralMaxRewards);
  const summary =
    `${config.referralEnabled ? "active" : "paused"} · ` +
    `${formatBalance(config.referralRewardAmount)} ${config.referralRewardType} · cap ${cap}`;

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role ?? "admin",
    action: "referral.config",
    targetType: "cooperativeConfig",
    targetId: coopId,
    detail: `Referral config updated — ${summary}`,
  }).catch(() => {});

  return { ok: true, message: `✅ Referral program updated — ${summary}.` };
}

/**
 * Toggle only the referral program on/off — used by the Board committee's
 * `referralpause` / `referralresume` commands. Coop-scoped write via `withTx` +
 * `setCoopContext` (the same RLS-safe path `setReferralConfig` uses), so it keeps
 * working once RLS is forced. Auditing is left to the caller so the board actor
 * role is preserved.
 */
export async function setReferralEnabled(
  coopId: string,
  enabled: boolean,
): Promise<{ ok: boolean; message: string }> {
  await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    await tx.cooperativeConfig.upsert({
      where: { cooperativeId: coopId },
      create: { cooperativeId: coopId, referralEnabled: enabled },
      update: { referralEnabled: enabled },
    });
  });

  return {
    ok: true,
    message: enabled
      ? "✅ Referral program *activated*. New referrals will be recorded and paid."
      : "⏸️ Referral program *paused*. No new referrals will be recorded or paid.",
  };
}

/**
 * A cooperative-wide referral summary for admins: the current configuration and
 * a breakdown of every referral by status, including the count of `qualified`
 * (earned but unpaid) referrals — the gated-airtime queue an admin must watch.
 * Coop-scoped read via `withTx` + `setCoopContext`.
 */
export async function referralReport(coopId: string): Promise<{ ok: boolean; message: string }> {
  const { config, rows, bonusOutstanding, withdrawals } = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    const config = await tx.cooperativeConfig.findUnique({ where: { cooperativeId: coopId } });
    const rows = await tx.referral.findMany({
      where: { cooperativeId: coopId },
      select: { status: true, rewardAmount: true },
    });
    const bonus = await tx.member.aggregate({
      where: { cooperativeId: coopId },
      _sum: { referralBonusBalance: true },
    });
    const withdrawals = await tx.referralWithdrawal.findMany({
      where: { cooperativeId: coopId },
      select: { status: true, amount: true },
    });
    return {
      config,
      rows,
      bonusOutstanding: bonus._sum.referralBonusBalance ?? 0,
      withdrawals,
    };
  });

  const count = (status: string) => rows.filter((r) => r.status === status).length;
  const paid = rows
    .filter((r) => r.status === "rewarded")
    .reduce((sum, r) => sum + (r.rewardAmount ?? 0), 0);
  const wdCount = (status: string) => withdrawals.filter((w) => w.status === status).length;
  const withdrawn = withdrawals
    .filter((w) => w.status === "paid")
    .reduce((sum, w) => sum + w.amount, 0);
  const amount = config?.referralRewardAmount ?? DEFAULT_REWARD_AMOUNT;
  const rewardType = config?.referralRewardType ?? DEFAULT_REWARD_TYPE;
  const cap = config?.referralMaxRewards ?? 0;

  return {
    ok: true,
    message:
      `📊 *Referral report*\n\n` +
      `Status: *${config?.referralEnabled ? "active" : "paused"}*\n` +
      `Reward: *${formatBalance(amount)} ${rewardType}*\n` +
      `Per-referrer cap: *${cap === 0 ? "unlimited" : cap}*\n\n` +
      `Referred: *${rows.length}*\n` +
      `• Pending: *${count("pending")}*\n` +
      `• Qualified (unpaid): *${count("qualified")}*\n` +
      `• Rewarded: *${count("rewarded")}*\n` +
      `• Rejected: *${count("rejected")}*\n\n` +
      `Rewards paid: *${formatBalance(paid)}*\n` +
      `Bonus outstanding: *${formatBalance(bonusOutstanding)}*\n` +
      `Withdrawals: *${withdrawals.length}* ` +
      `(paid *${wdCount("paid")}*, pending *${wdCount("pending")}*, failed *${wdCount("failed")}*)\n` +
      `Withdrawn: *${formatBalance(withdrawn)}*`,
  };
}

export interface ReferralBonus {
  ok: boolean;
  balance: number;
  message: string;
}

interface WithdrawalMember {
  name: string;
  bankAccountNumber: string | null;
  bankCode: string | null;
  bankName: string | null;
  wallet: { id: string } | null;
}

type WithdrawPrep =
  | { kind: "no_member" }
  | { kind: "insufficient" }
  | { kind: "proceed"; withdrawalId: string; member: WithdrawalMember };

/** A payout failure that is DEFINITELY not in flight — safe to refund. */
class DefiniteWithdrawalError extends Error {}

/**
 * The member's current withdrawable referral bonus (kobo). RLS-safe read via
 * `withTx` + `setCoopContext`.
 */
export async function getReferralBonus(coopId: string, memberId: string): Promise<ReferralBonus> {
  const member = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    return tx.member.findFirst({
      where: { id: memberId, cooperativeId: coopId },
      select: { referralBonusBalance: true },
    });
  });

  if (!member) return { ok: false, balance: 0, message: "Member not found." };

  return {
    ok: true,
    balance: member.referralBonusBalance,
    message: `Your referral bonus balance is *${formatBalance(member.referralBonusBalance)}*.`,
  };
}

/**
 * Withdraw any amount of the member's referral bonus to `wallet`, `bank` (the
 * member's SAVED account only) or `airtime` (any phone number).
 *
 * The balance is debited with a CONDITIONAL update (`balance >= amount`) in the
 * same transaction that creates the `pending` `ReferralWithdrawal` row — two
 * concurrent withdrawals can never overdraw. The provider call runs OUTSIDE any
 * transaction (callers defer it via `enqueueAfterCommit`), because a chat
 * handler wraps its work in one transaction and a provider call must not span
 * it. On a definite failure the debit is refunded and the row marked `failed`;
 * on an `unsure` outcome the row stays `pending` for reconciliation (no refund,
 * no blind retry).
 */
export async function withdrawReferralBonus(
  coopId: string,
  memberId: string,
  input: { amount: number; destination: "wallet" | "bank" | "airtime"; phone?: string },
  actor: { id: string; phone: string },
): Promise<{ ok: boolean; message: string; withdrawalId?: string }> {
  const amount = input.amount;
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, message: "Enter a positive amount to withdraw." };
  }
  const destination = input.destination;
  if (!WITHDRAWAL_DESTINATIONS.has(destination)) {
    return {
      ok: false,
      message: `Unknown destination *${destination}*. Use *wallet*, *bank* or *airtime*.`,
    };
  }
  const phone = input.phone?.trim();
  if (destination === "airtime" && !phone) {
    return { ok: false, message: "Enter the phone number to send the airtime to." };
  }

  // 1. Read + conditional debit + record the withdrawal, all in ONE coop-scoped
  //    transaction. The debit can never overdraw.
  const prep = await withTx(async (tx): Promise<WithdrawPrep> => {
    await setCoopContext(tx as never, coopId);
    const member = await tx.member.findFirst({
      where: { id: memberId, cooperativeId: coopId },
      select: {
        name: true,
        bankAccountNumber: true,
        bankCode: true,
        bankName: true,
        wallet: { select: { id: true } },
      },
    });
    if (!member) return { kind: "no_member" };

    const debited = await tx.member.updateMany({
      where: { id: memberId, cooperativeId: coopId, referralBonusBalance: { gte: amount } },
      data: { referralBonusBalance: { decrement: amount } },
    });
    if (debited.count === 0) return { kind: "insufficient" };

    const withdrawal = await tx.referralWithdrawal.create({
      data: {
        cooperativeId: coopId,
        memberId,
        amount,
        destination,
        phone: phone ?? null,
        status: "pending",
      },
    });
    return { kind: "proceed", withdrawalId: withdrawal.id, member };
  });

  if (prep.kind === "no_member") return { ok: false, message: "Member not found." };
  if (prep.kind === "insufficient") {
    return { ok: false, message: "Insufficient referral bonus." };
  }

  const { withdrawalId, member } = prep;
  const reference = `REFBONUS-${withdrawalId}`;

  // 2. Disburse OUTSIDE the transaction. `withdrawReferralBonus` never opens a
  //    tx around the provider call.
  let providerRef: string | undefined;
  try {
    if (destination === "wallet") {
      if (!member.wallet) {
        throw new DefiniteWithdrawalError("You have no wallet to credit.");
      }
      await creditReferralBonusToWallet(coopId, memberId, member.wallet.id, withdrawalId, amount);
    } else if (destination === "bank") {
      if (!member.bankAccountNumber || !member.bankCode) {
        throw new DefiniteWithdrawalError(
          "Add your bank account before withdrawing your referral bonus to bank.",
        );
      }
      const result = await sendToBank({
        memberId,
        amount,
        bankAccountNumber: member.bankAccountNumber,
        bankCode: member.bankCode,
        bankName: member.bankName ?? undefined,
        note: `Referral bonus withdrawal ${withdrawalId.slice(-6)}`,
        idempotencyKey: reference,
      });
      if (!result.ok) {
        if (result.status === "unsure") {
          await markWithdrawalUnconfirmed(coopId, memberId, withdrawalId, amount, result.message);
          return {
            ok: true,
            withdrawalId,
            message:
              "⏳ Your referral bonus withdrawal was submitted and is being confirmed — do not retry.",
          };
        }
        throw new DefiniteWithdrawalError(result.message);
      }
      providerRef = result.payoutId;
    } else {
      const provider = resolveVtuProvider();
      if (!provider) {
        throw new DefiniteWithdrawalError("Airtime withdrawals are not enabled yet.");
      }
      const result = await provider.recharge({
        phone: phone as string,
        amountKobo: amount,
        reference,
      });
      if (!result.ok) {
        if (result.unsure) {
          await markWithdrawalUnconfirmed(
            coopId,
            memberId,
            withdrawalId,
            amount,
            result.error ?? "outcome unknown",
          );
          return {
            ok: true,
            withdrawalId,
            message:
              "⏳ Your referral bonus withdrawal was submitted and is being confirmed — do not retry.",
          };
        }
        throw new DefiniteWithdrawalError(result.error ?? "airtime recharge failed");
      }
      providerRef = result.providerRef;
    }
  } catch (err) {
    // Definite failure — refund the debit so no bonus is stranded.
    const message =
      err instanceof DefiniteWithdrawalError
        ? err.message
        : `Withdrawal failed: ${err instanceof Error ? err.message : String(err)}`;
    await failWithdrawalAndRefund(coopId, memberId, withdrawalId, amount, message);
    return { ok: false, message, withdrawalId };
  }

  // 3. Success — mark paid + audit.
  await markWithdrawalPaid(coopId, withdrawalId, providerRef);
  const paidTo =
    destination === "airtime"
      ? `${phone} (airtime)`
      : destination === "bank"
        ? `${member.name}'s bank account`
        : `${member.name}'s wallet`;
  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    action: "referral.bonus.withdrawn",
    targetType: "referralWithdrawal",
    targetId: withdrawalId,
    amount,
    detail: `Withdrew ${formatBalance(amount)} referral bonus to ${paidTo}`,
  }).catch(() => {});

  return {
    ok: true,
    withdrawalId,
    message: `✅ ${formatBalance(amount)} of referral bonus sent to ${paidTo}.`,
  };
}

/**
 * Credit the member's wallet with a balanced journal entry, then increment the
 * wallet balance — the double-entry `expense:referral_reward` DEBIT /
 * `member_wallet:<id>` CREDIT pattern, in one RLS-scoped transaction. The
 * deterministic `txRef` makes a replay idempotent.
 */
async function creditReferralBonusToWallet(
  coopId: string,
  memberId: string,
  walletId: string,
  withdrawalId: string,
  amount: number,
): Promise<void> {
  await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    await postJournal(
      {
        cooperativeId: coopId,
        txRef: `REFBONUS-${withdrawalId}`,
        description: `Referral bonus withdrawal ${withdrawalId.slice(-6)} — ${formatBalance(amount)}`,
        postings: [
          { account: INTERNAL_REWARD_ACCOUNT, direction: "DEBIT", amount },
          { account: `member_wallet:${walletId}`, direction: "CREDIT", amount, memberId },
        ],
        throwOnDuplicate: true,
      },
      tx as never,
    );
    await tx.wallet.update({ where: { id: walletId }, data: { balance: { increment: amount } } });
  });
}

/** Mark a settled withdrawal `paid` with its provider reference. */
async function markWithdrawalPaid(
  coopId: string,
  withdrawalId: string,
  providerRef: string | undefined,
): Promise<void> {
  await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    await tx.referralWithdrawal.update({
      where: { id: withdrawalId },
      data: { status: "paid", paidAt: new Date(), providerRef: providerRef ?? null },
    });
  });
}

/**
 * Refund a definite failure: mark the withdrawal `failed` and re-credit the
 * bonus, in one transaction (so the money is never lost), then audit. The
 * `status: "pending"` guard makes a double-refund impossible.
 */
async function failWithdrawalAndRefund(
  coopId: string,
  memberId: string,
  withdrawalId: string,
  amount: number,
  reason: string,
): Promise<void> {
  const reverted = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    const claimed = await tx.referralWithdrawal.updateMany({
      where: { id: withdrawalId, status: "pending" },
      data: { status: "failed", note: reason.slice(0, 200) },
    });
    if (claimed.count === 0) return false;
    await tx.member.updateMany({
      where: { id: memberId, cooperativeId: coopId },
      data: { referralBonusBalance: { increment: amount } },
    });
    return true;
  });

  if (!reverted) return;
  await audit({
    cooperativeId: coopId,
    actorPhone: "",
    actorId: memberId,
    action: "referral.bonus.withdraw_failed",
    targetType: "referralWithdrawal",
    targetId: withdrawalId,
    amount,
    detail: `Referral bonus withdrawal of ${formatBalance(amount)} failed and was refunded — ${reason}`,
  }).catch(() => {});
}

/**
 * An `unsure` outcome: the provider may have paid. Leave the withdrawal
 * `pending` (no refund, no retry) and audit for reconciliation.
 */
async function markWithdrawalUnconfirmed(
  coopId: string,
  memberId: string,
  withdrawalId: string,
  amount: number,
  reason: string,
): Promise<void> {
  await audit({
    cooperativeId: coopId,
    actorPhone: "",
    actorId: memberId,
    action: "referral.bonus.unconfirmed",
    targetType: "referralWithdrawal",
    targetId: withdrawalId,
    amount,
    detail: `Referral bonus withdrawal of ${formatBalance(amount)} is UNCONFIRMED (${reason}) — reconcile before any retry.`,
  }).catch(() => {});
}

/**
 * Withdrawal history for a member (or the whole coop when `memberId` is
 * omitted). RLS-scoped read via `withTx` + `setCoopContext`.
 */
export async function listReferralWithdrawals(
  coopId: string,
  memberId?: string,
): Promise<{ ok: boolean; message: string }> {
  const rows = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    return tx.referralWithdrawal.findMany({
      where: { cooperativeId: coopId, ...(memberId ? { memberId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  });

  if (rows.length === 0) {
    return { ok: true, message: "You have no referral withdrawals yet." };
  }

  const lines = rows
    .map((r) => `• ${formatBalance(r.amount)} → ${r.destination} — ${r.status}`)
    .join("\n");

  return {
    ok: true,
    message: `💸 *Referral withdrawals*\n\n${lines}`,
  };
}
