import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { sendText, notifyMember } from "../lib/messaging.js";
import { sendToBank } from "./disbursements.js";
import { LIMITS } from "../lib/money.js";
import { audit } from "./audit.js";
import { checkVelocity } from "./fraud.js";
import { getCoopConfig } from "./coop-config.js";
import { recordLedger } from "./ledger.js";
import { checkTenureLimit } from "../lib/security-hardening.js";
import { flagTransaction } from "./aml.js";

/** Maximum share of savings a member can withdraw at once. */
export const WITHDRAW_LIMIT_RATIO = 0.45;
/** Minimum gap between two withdrawals (6 months). */
export const WITHDRAW_COOLDOWN_MS = 180 * 24 * 60 * 60 * 1000;

export interface WithdrawResult {
  ok: boolean;
  message: string;
}

/** Resolve short ID to full withdrawal request ID, ensuring uniqueness. */
async function resolveRequestId(shortId: string): Promise<{ id: string } | { error: string }> {
  // Try exact match first
  const exact = await prisma.withdrawalRequest.findUnique({ where: { id: shortId }, select: { id: true } });
  if (exact) return exact;

  // Try suffix match — require exactly one result
  const matches = await prisma.withdrawalRequest.findMany({
    where: { id: { endsWith: shortId } },
    select: { id: true },
    take: 2,
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { error: `Multiple requests match "${shortId}" — use a longer ID to disambiguate.` };
  return { error: "Withdrawal request not found. Check the id." };
}

/** The maximum a member can withdraw right now (45% of current balance). */
export async function withdrawLimit(phone: string): Promise<{ balance: number; max: number } | null> {
  const member = await prisma.member.findFirst({
    where: { phone },
    include: { wallet: true },
  });
  if (!member || !member.wallet) return null;
  const balance = member.wallet.balance ?? 0;
  return { balance, max: Math.floor(balance * WITHDRAW_LIMIT_RATIO) };
}

/** Is this member allowed to withdraw under the 6-month rule? */
export async function canWithdraw(phone: string): Promise<{ ok: boolean; message: string; member: any }> {
  const member = await prisma.member.findFirst({ where: { phone }, include: { wallet: true } });
  if (!member || !member.wallet) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*.", member: null };
  }
  if (member.status === "deceased") {
    return { ok: false, message: "This account is under a death claim. The family withdrawal is handled by the cooperative admin.", member };
  }
  if (member.lastWithdrawalAt && !member.withdrawalOverride) {
    const coopConfig = await getCoopConfig(member.cooperativeId);
    const cooldownMs = coopConfig.withdrawalCooldownMonths * 30 * 24 * 60 * 60 * 1000;
    const elapsed = Date.now() - member.lastWithdrawalAt.getTime();
    if (elapsed < cooldownMs) {
      const daysLeft = Math.ceil((cooldownMs - elapsed) / (24 * 60 * 60 * 1000));
      return {
        ok: false,
        message: `You can only withdraw once every ${coopConfig.withdrawalCooldownMonths} months. You can withdraw again in about *${daysLeft} days* — or ask an admin to *override* the rule.`,
        member,
      };
    }
  }
  return { ok: true, message: "", member };
}

/**
 * Request a withdrawal. The request needs an admin approval, then the super
 * admin's final approval, before the money is sent.
 *
 * Uses a serializable transaction to prevent concurrent duplicate requests
 * from passing the 6-month eligibility check.
 */
export async function requestWithdrawal(
  phone: string,
  amount: number,
  bank?: { accountNumber: string; bankCode: string; bankName?: string },
): Promise<WithdrawResult> {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Enter a valid amount, e.g. *withdraw 5000*." };
  }
  // Get the member first to access cooperative config
  const memberForConfig = await prisma.member.findFirst({ where: { phone } });
  if (memberForConfig) {
    const coopConfig = await getCoopConfig(memberForConfig.cooperativeId);
    if (amount < coopConfig.minWithdrawal) {
      return { ok: false, message: `Minimum withdrawal amount is *${formatBalance(coopConfig.minWithdrawal)}*.` };
    }
    if (amount > coopConfig.maxWithdrawal) {
      return { ok: false, message: `Maximum withdrawal amount is *${formatBalance(coopConfig.maxWithdrawal)}*.` };
    }
  } else {
    // amount is in kobo
    if (amount < LIMITS.MIN_WITHDRAW) {
      return { ok: false, message: `Minimum withdrawal amount is *${formatBalance(LIMITS.MIN_WITHDRAW)}*.` };
    }
    if (amount > LIMITS.MAX_WITHDRAW) {
      return { ok: false, message: `Maximum withdrawal amount is *${formatBalance(LIMITS.MAX_WITHDRAW)}*.` };
    }
  }

  // Atomic eligibility check + request creation inside a transaction.
  // SELECT ... FOR UPDATE locks the member row so concurrent requests queue.
  const result = await prisma.$transaction(async (tx) => {
    const member = await tx.member.findFirst({
      where: { phone },
      include: { wallet: true },
    });
    if (!member || !member.wallet) {
      return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." } as const;
    }
    if (member.frozenAt) {
      return { ok: false, message: "🔒 Your wallet is frozen, so you can't withdraw right now. Reply *unfreeze* to lift the freeze." } as const;
    }
    if (member.status === "deceased") {
      return { ok: false, message: "This account is under a death claim." } as const;
    }
    if (member.lastWithdrawalAt && !member.withdrawalOverride) {
      const coopConfig = await getCoopConfig(member.cooperativeId);
      const cooldownMs = coopConfig.withdrawalCooldownMonths * 30 * 24 * 60 * 60 * 1000;
      const elapsed = Date.now() - member.lastWithdrawalAt.getTime();
      if (elapsed < cooldownMs) {
        const daysLeft = Math.ceil((cooldownMs - elapsed) / (24 * 60 * 60 * 1000));
        return {
          ok: false,
          message: `You can only withdraw once every ${coopConfig.withdrawalCooldownMonths} months. Try again in *${daysLeft} days* — or ask an admin to *override* the rule.`,
        } as const;
      }
    }

    const balance = member.wallet.balance ?? 0;
    const max = Math.floor(balance * WITHDRAW_LIMIT_RATIO);
    if (amount > max) {
      return {
        ok: false,
        message: `You can withdraw at most *${formatBalance(max)}* (45% of your ${formatBalance(balance)} balance).`,
      } as const;
    }

    // Tenure-based daily limit check (playbook Attack 9 mitigation)
    const tenureCheck = await checkTenureLimit({
      memberId: member.id,
      amount,
      cooperativeId: member.cooperativeId,
    });
    if (!tenureCheck.allowed) {
      return { ok: false, message: tenureCheck.message } as const;
    }

    const accNo = bank?.accountNumber ?? member.bankAccountNumber;
    const bankCode = bank?.bankCode ?? member.bankCode;
    const bankName = bank?.bankName ?? member.bankName;
    if (!accNo || !bankCode) {
      return {
        ok: false,
        message: "No bank account on file. Reply *withdraw <amount> <account number> <bank>* to set one.",
      } as const;
    }

    const request = await tx.withdrawalRequest.create({
      data: {
        amount,
        status: "pending",
        bankAccountNumber: accNo,
        bankCode,
        bankName: bankName ?? null,
        memberId: member.id,
        cooperativeId: member.cooperativeId,
      },
    });

    await tx.member.update({
      where: { id: member.id },
      data: { bankAccountNumber: accNo, bankCode, bankName },
    });

    return {
      ok: true as const,
      message: "",
      request,
      member,
      accNo,
      bankCode,
      bankName,
    };
  });

  if (!result.ok) return { ok: false, message: result.message };

  await notifySuperAdmins(
    result.member.cooperativeId,
    `💰 *Withdrawal request* ${result.request.id.slice(-6)}\n${result.member.name} wants to withdraw *${formatBalance(amount)}* to ${result.bankName ?? result.bankCode} ****${result.accNo.slice(-4)}.\n\nAdmin: *approvewithdraw ${result.request.id.slice(-6)}* or *rejectwithdraw ${result.request.id.slice(-6)}*. Super admin's final approval pays it out.`,
  );

  return {
    ok: true,
    message: `✅ Withdrawal of *${formatBalance(amount)}* requested.\n\nIt needs an *admin approval*, then the *super admin's final approval*, before the money is sent to ${result.bankName ?? result.bankCode} ****${result.accNo.slice(-4)}.`,
  };
}

/** Admin/super admin approval. Super admin approval also pays out immediately. */
export async function approveWithdrawal(
  requestId: string,
  actor: { id: string; role: string; phone: string },
): Promise<WithdrawResult> {
  const fullId = await resolveRequestId(requestId);
  if ("error" in fullId) return { ok: false, message: fullId.error };
  const request = await prisma.withdrawalRequest.findFirst({
    where: { id: fullId.id },
    include: { member: true },
  });
  if (!request) return { ok: false, message: "Withdrawal request not found. Check the id." };
  if (["paid", "rejected", "processing"].includes(request.status)) {
    return { ok: false, message: `This request is already ${request.status}.` };
  }

  // Dual-control: nobody approves their own money leaving the cooperative.
  if (actor.id === request.memberId) {
    return {
      ok: false,
      message: `⛔ You can't approve your own withdrawal. Another admin must do that.`,
    };
  }

  const isSuper = actor.role === "superadmin" || (await isSuperAdminOf(actor.phone, request.cooperativeId));

  if (isSuper && ["pending", "admin_approved"].includes(request.status)) {
    return finalizeWithdrawal(requestId, actor);
  }

  // Atomic transition — two admins approving at once: only ONE flips it.
  const moved = await prisma.withdrawalRequest.updateMany({
    where: { id: request.id, status: "pending" },
    data: { status: "admin_approved", adminApprovedAt: new Date(), adminApprovedById: actor.id },
  });
  if (moved.count === 0) {
    return { ok: false, message: `This request is no longer pending — check its current state.` };
  }
  await notifySuperAdmins(
    request.cooperativeId,
    `✅ Withdrawal *${request.id.slice(-6)}* for ${request.member.name} approved by an admin. As super admin, reply *finalize ${request.id.slice(-6)}* to send *${formatBalance(request.amount)}* to the member's bank.`,
  );
  return {
    ok: true,
    message: `Withdrawal *${request.id.slice(-6)}* for ${request.member.name} approved. The *super admin* must reply *finalize ${request.id.slice(-6)}* before the money is sent.`,
  };
}

/**
 * Super admin's final approval — sends the money and debits the wallet.
 *
 * Saga ordering (crash-safe):
 *   1. ATOMIC CLAIM: pending/admin_approved -> processing. Exactly one
 *      concurrent finalizer proceeds; everyone else gets "already handled".
 *   2. DEBIT the wallet atomically (balance-guarded decrement).
 *   3. PAY via provider using a deterministic idempotency key
 *      (TFR-WDR-<requestId>) — retries can never pay twice.
 *   4a. Success  -> mark paid (+ cooldown reset).
 *   4b. Failure  -> REFUND the wallet and hand the request back for retry.
 */
export async function finalizeWithdrawal(
  requestId: string,
  actor: { id: string; role: string; phone: string },
): Promise<WithdrawResult> {
  const fullId = await resolveRequestId(requestId);
  if ("error" in fullId) return { ok: false, message: fullId.error };
  const request = await prisma.withdrawalRequest.findFirst({
    where: { id: fullId.id },
    include: { member: true },
  });
  if (!request) return { ok: false, message: "Withdrawal request not found." };
  if (request.status === "paid") return { ok: false, message: "This withdrawal was already paid." };
  if (request.status === "rejected") return { ok: false, message: "This withdrawal was rejected." };
  if (request.status === "processing") {
    return { ok: false, message: "This withdrawal is being processed right now — wait for it to settle." };
  }

  const isSuper = actor.role === "superadmin" || (await isSuperAdminOf(actor.phone, request.cooperativeId));
  if (!isSuper) {
    return { ok: false, message: "Only the cooperative's super admin can give the final approval." };
  }

  // Dual-control: nobody finalizes their own withdrawal.
  if (actor.id === request.memberId) {
    return {
      ok: false,
      message: `⛔ You can't finalize your own withdrawal. Another super admin must do that.`,
    };
  }

  // Velocity check: max 5 money-out per 10 minutes per member.
  if (!await checkVelocity(request.memberId)) {
    return {
      ok: false,
      message: `🛑 Too many transactions in a short period. Please wait a few minutes and try again.`,
    };
  }

  // STEP 1 — atomic claim.
  const claimed = await prisma.withdrawalRequest.updateMany({
    where: { id: request.id, status: { in: ["pending", "admin_approved"] } },
    data: { status: "processing", finalizedById: actor.id },
  });
  if (claimed.count === 0) {
    return { ok: false, message: "This withdrawal was just taken by another approval — check *pending*." };
  }

  const member = request.member;
  const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });

  // Tracks whether the bank transfer actually succeeded. The outer catch must
  // NOT refund the wallet once money has been sent (that would double-pay).
  let paid = false;

  try {
    // STEP 2 — debit BEFORE paying. If the balance can't cover it the whole
    // thing stops here; no money ever leaves the cooperative's bank.
    if (!wallet || wallet.balance < request.amount) {
      await prisma.withdrawalRequest.updateMany({
        where: { id: request.id, status: "processing" },
        data: { status: "rejected", rejectedAt: new Date() },
      });
      return { ok: false, message: `Insufficient balance (${formatBalance(wallet?.balance ?? 0)}). Request rejected.` };
    }
    const debited = await prisma.wallet.updateMany({
      where: { id: wallet.id, balance: { gte: request.amount } },
      data: { balance: { decrement: request.amount } },
    });
    if (debited.count === 0) {
      await prisma.withdrawalRequest.updateMany({
        where: { id: request.id, status: "processing" },
        data: { status: "rejected", rejectedAt: new Date() },
      });
      return { ok: false, message: "Balance changed during payout — request rejected. Investigate immediately." };
    }

    // STEP 3 — pay out (deterministic key => provider retries are safe).
    const result = await sendToBank({
      memberId: member.id,
      amount: request.amount,
      bankAccountNumber: request.bankAccountNumber,
      bankCode: request.bankCode,
      bankName: request.bankName ?? undefined,
      note: `Member withdrawal (finalized by super admin)`,
      idempotencyKey: `TFR-WDR-${request.id}`,
      // The withdrawal books its own category ledger (expense:withdrawal) with
      // its own assets:bank CREDIT below; suppress payOut's generic journal so
      // the bank account is credited exactly once.
      suppressJournal: true,
    });

    if (result.status === "unsure") {
      // The provider may have submitted the transfer. NEVER auto-refund here or
      // the member keeps their money AND the payout lands → double payment.
      // Flag for manual reconciliation.
      await prisma.$transaction([
        prisma.withdrawalRequest.updateMany({
          where: { id: request.id },
          data: { status: "investigating" },
        }),
      ]);
      await notifySuperAdmins(
        request.cooperativeId,
        `🔍 Withdrawal *${request.id.slice(-6)}* has an *unconfirmed payout outcome*. The bank transfer may have been sent but could not be confirmed in-app. Please reconcile with the payment provider before retrying or refunding.`,
      );
      return { ok: false, message: `⚠️ The payout could not be confirmed. Do NOT retry or refund until an admin reconciles with the provider: ${result.message}` };
    }

    if (!result.ok) {
      // STEP 4b — refund and hand back for retry/rejection by humans.
      // Only reached when the provider CONFIRMED the transfer did not go out,
      // so the refund is safe.
      await prisma.$transaction([
        prisma.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: request.amount } } }),
        prisma.withdrawalRequest.updateMany({
          where: { id: request.id },
          data: { status: "admin_approved" },
        }),
      ]);
      console.error(`[withdrawal] payout failed, refunded: ${request.id} — ${result.message}`);
      return { ok: false, message: `Withdrawal not paid out (wallet refunded): ${result.message}` };
    }

    // STEP 4a — success.
    await prisma.$transaction([
      prisma.withdrawalRequest.updateMany({
        where: { id: request.id, status: "processing" },
        data: { status: "paid", finalizedAt: new Date(), finalizedById: actor.id },
      }),
      prisma.member.update({
        where: { id: member.id },
        data: { lastWithdrawalAt: new Date(), withdrawalOverride: false },
      }),
    ]);
    // Money HAS left the bank from here on — the outer catch must not refund.
    paid = true;

    // AML/CFT: flag + auto-file STR for large/suspicious withdrawals.
    try {
      await flagTransaction({
        memberId: member.id,
        cooperativeId: request.cooperativeId,
        amount: request.amount,
        type: "withdrawal",
        direction: "out",
        createdAt: request.createdAt,
      });
    } catch (err) {
      console.error("[withdrawal] AML flag failed:", err);
    }

    // Post-success bookkeeping is best-effort — a failure here must NOT roll
    // back the debit/refund (the bank transfer already happened).
    try {
      // Record ledger entry for the withdrawal
      await recordLedger({
        cooperativeId: request.cooperativeId,
        type: "expense",
        category: "withdrawal",
        amount: request.amount,
        note: `Member withdrawal by ${member.name}`,
        reference: request.id,
        fundType: "member",
      });

      const balanceAfter = (wallet.balance ?? 0) - request.amount;
      await audit({
        cooperativeId: request.cooperativeId,
        actorPhone: actor.phone,
        actorId: actor.id,
        actorRole: actor.role,
        action: "withdrawal.finalize",
        targetType: "withdrawal",
        targetId: request.id,
        amount: request.amount,
        balanceBefore: wallet.balance ?? 0,
        balanceAfter,
        detail: `${formatBalance(request.amount)} to ${member.name}`,
      });
    } catch (err) {
      console.error("[withdrawal] post-payout bookkeeping failed:", err);
    }

    return {
      ok: true,
      message: `✅ *${formatBalance(request.amount)}* sent to ${request.member.name} (${request.bankName ?? request.bankCode} ****${request.bankAccountNumber.slice(-4)}). Wallet debited.`,
    };
  } catch (err: any) {
    // Crash safety — any throw after the debit must be handled WITHOUT
    // double-paying. Once money has been sent (paid), never auto-refund:
    // flag for manual reconciliation instead.
    if (paid) {
      await prisma.withdrawalRequest
        .updateMany({
          where: { id: request.id },
          data: { status: "investigating" },
        })
        .catch(() => {});
      await notifySuperAdmins(
        request.cooperativeId,
        `🔍 Withdrawal *${request.id.slice(-6)}* sent money but later bookkeeping threw. Reconcile with the payment provider.`,
      ).catch(() => {});
      console.error(`[withdrawal] post-payout error for paid withdrawal: ${request.id}`, err);
      return { ok: false, message: `⚠️ The payout was sent but in-app bookkeeping failed. It was flagged for manual reconciliation.` };
    }
    await prisma.withdrawalRequest
      .updateMany({
        where: { id: request.id },
        data: { status: "investigating" },
      })
      .catch(() => {});
    await notifySuperAdmins(
      request.cooperativeId,
      `🔍 Withdrawal *${request.id.slice(-6)}* hit an unexpected error with an unconfirmed outcome. Reconcile with the payment provider before retrying.`,
    ).catch(() => {});
    console.error(`[withdrawal] finalized threw (unconfirmed outcome): ${request.id}`, err);
    return { ok: false, message: `Withdrawal hit an unexpected error with an *unconfirmed* outcome and was flagged for reconciliation (${String(err?.message ?? err).slice(0, 120)}).` };
  }
}

export async function rejectWithdrawal(requestId: string): Promise<WithdrawResult> {
  const fullId = await resolveRequestId(requestId);
  if ("error" in fullId) return { ok: false, message: fullId.error };
  const request = await prisma.withdrawalRequest.findFirst({
    where: { id: fullId.id },
    include: { member: true },
  });
  if (!request) return { ok: false, message: "Withdrawal request not found." };
  if (request.status === "paid" || request.status === "rejected") {
    return { ok: false, message: `This request is already ${request.status}.` };
  }
  // Atomic — can't reject something that just flipped to paid/processing.
  const moved = await prisma.withdrawalRequest.updateMany({
    where: { id: request.id, status: { in: ["pending", "admin_approved"] } },
    data: { status: "rejected", rejectedAt: new Date() },
  });
  if (moved.count === 0) {
    return { ok: false, message: `This request just changed state (now ${request.status}) — it wasn't rejected.` };
  }
  return { ok: true, message: `Withdrawal *${request.id.slice(-6)}* for ${request.member.name} was rejected.` };
}

/** Grant an admin override so a member can withdraw before the 6-month window. */
export async function overrideWithdrawalRule(phone: string, memberPhone: string): Promise<WithdrawResult> {
  const member = await prisma.member.findFirst({
    where: { phone: memberPhone, cooperative: { members: { some: { phone } } } },
  });
  if (!member) return { ok: false, message: "No member found with that phone in your cooperative." };
  await prisma.member.update({ where: { id: member.id }, data: { withdrawalOverride: true } });
  return {
    ok: true,
    message: `Withdrawal override granted for *${member.name}*. They can now withdraw before the 6-month window.`,
  };
}

/** Send a message to every super admin of a cooperative. */
export async function notifySuperAdmins(cooperativeId: string, text: string): Promise<void> {
  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });
  const supers = await prisma.member.findMany({
    where: { cooperativeId, role: "superadmin", status: "active" },
  });
  const seen = new Set<string>();
  for (const s of supers) {
    if (!s.phone || seen.has(s.phone)) continue;
    seen.add(s.phone);
    await notifyMember(s, text).catch(() => {});
  }
  if (coop?.adminPhone && !seen.has(coop.adminPhone)) {
    await sendText({ to: coop.adminPhone, text }).catch(() => {});
  }
}

async function isSuperAdminOf(phone: string, cooperativeId: string): Promise<boolean> {
  const member = await prisma.member.findFirst({
    where: { phone, cooperativeId },
    include: { cooperative: { select: { adminPhone: true } } },
  });
  if (!member) return false;
  if (member.role === "superadmin") return true;
  return member.cooperative?.adminPhone === phone;
}