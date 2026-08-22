import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { sendText } from "../lib/messaging.js";
import { sendToBank } from "./disbursements.js";
import { ensureBeneficiaryAllowed } from "./beneficiaries.js";

/** Maximum share of savings a member can withdraw at once. */
export const WITHDRAW_LIMIT_RATIO = 0.45;
/** Minimum gap between two withdrawals (6 months). */
export const WITHDRAW_COOLDOWN_MS = 180 * 24 * 60 * 60 * 1000;

export interface WithdrawResult {
  ok: boolean;
  message: string;
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
    const elapsed = Date.now() - member.lastWithdrawalAt.getTime();
    if (elapsed < WITHDRAW_COOLDOWN_MS) {
      const daysLeft = Math.ceil((WITHDRAW_COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000));
      return {
        ok: false,
        message: `You can only withdraw once every 6 months. You can withdraw again in about *${daysLeft} days* — or ask an admin to *override* the rule.`,
        member,
      };
    }
  }
  return { ok: true, message: "", member };
}

/**
 * Request a withdrawal. The request needs an admin approval, then the super
 * admin's final approval, before the money is sent.
 */
export async function requestWithdrawal(
  phone: string,
  amount: number,
  bank?: { accountNumber: string; bankCode: string; bankName?: string },
): Promise<WithdrawResult> {
  const eligibility = await canWithdraw(phone);
  if (!eligibility.ok) return { ok: false, message: eligibility.message };
  const member = eligibility.member;

  const balance = member.wallet.balance ?? 0;
  const max = Math.floor(balance * WITHDRAW_LIMIT_RATIO);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Enter a valid amount, e.g. *withdraw 5000*." };
  }
  if (amount > max) {
    return {
      ok: false,
      message: `You can withdraw at most *${formatBalance(max)}* (45% of your ${formatBalance(balance)} balance).`,
    };
  }

  const accNo = bank?.accountNumber ?? member.bankAccountNumber;
  const bankCode = bank?.bankCode ?? member.bankCode;
  const bankName = bank?.bankName ?? member.bankName;
  if (!accNo || !bankCode) {
    return {
      ok: false,
      message: "No bank account on file. Reply *withdraw <amount> <account number> <bank>* to set one, e.g. *withdraw 5000 0123456789 Access*.",
    };
  }

  // New-payee cooling period — a hijacked account changing bank details then
  // withdrawing same-day is the classic takeover pattern; slow it down.
  const beneficiaryCheck = await ensureBeneficiaryAllowed({
    cooperativeId: member.cooperativeId,
    memberId: member.id,
    accountNumber: accNo,
    bankCode,
    bankName,
  });
  if (!beneficiaryCheck.ok) {
    return { ok: false, message: beneficiaryCheck.message! };
  }

  const request = await prisma.withdrawalRequest.create({
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

  await prisma.member.update({
    where: { id: member.id },
    data: { bankAccountNumber: accNo, bankCode, bankName },
  });

  await notifySuperAdmins(
    member.cooperativeId,
    `💰 *Withdrawal request* ${request.id.slice(-6)}\n${member.name} wants to withdraw *${formatBalance(amount)}* to ${bankName ?? bankCode} ****${accNo.slice(-4)}.\n\nAdmin: *approvewithdraw ${request.id.slice(-6)}* or *rejectwithdraw ${request.id.slice(-6)}*. Super admin's final approval pays it out.`,
  );

  return {
    ok: true,
    message: `✅ Withdrawal of *${formatBalance(amount)}* requested.\n\nIt needs an *admin approval*, then the *super admin's final approval*, before the money is sent to ${bankName ?? bankCode} ****${accNo.slice(-4)}.`,
  };
}

/** Admin/super admin approval. Super admin approval also pays out immediately. */
export async function approveWithdrawal(
  requestId: string,
  actor: { id: string; role: string; phone: string },
): Promise<WithdrawResult> {
  const request = await prisma.withdrawalRequest.findFirst({
    where: { OR: [{ id: requestId }, { id: { startsWith: requestId } }, { id: { endsWith: requestId } }] },
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
  const request = await prisma.withdrawalRequest.findFirst({
    where: { OR: [{ id: requestId }, { id: { startsWith: requestId } }, { id: { endsWith: requestId } }] },
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
    });

    if (!result.ok) {
      // STEP 4b — refund and hand back for retry/rejection by humans.
      await prisma.$transaction([
        prisma.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: request.amount } } }),
        prisma.withdrawalRequest.updateMany({
          where: { id: request.id, status: "processing" },
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

    return {
      ok: true,
      message: `✅ *${formatBalance(request.amount)}* sent to ${request.member.name} (${request.bankName ?? request.bankCode} ****${request.bankAccountNumber.slice(-4)}). Wallet debited.`,
    };
  } catch (err: any) {
    // Crash safety — anything thrown after the debit must restore funds.
    if (wallet) {
      await prisma.wallet
        .updateMany({
          where: { id: wallet.id },
          data: { balance: { increment: request.amount } },
        })
        .catch(() => {});
    }
    await prisma.withdrawalRequest
      .updateMany({
        where: { id: request.id, status: "processing" },
        data: { status: "admin_approved" },
      })
      .catch(() => {});
    console.error(`[withdrawal] finalized threw, refunded: ${request.id}`, err);
    return { ok: false, message: `Withdrawal failed and the wallet was refunded (${String(err?.message ?? err).slice(0, 120)}).` };
  }
}

export async function rejectWithdrawal(requestId: string): Promise<WithdrawResult> {
  const request = await prisma.withdrawalRequest.findFirst({
    where: { OR: [{ id: requestId }, { id: { startsWith: requestId } }, { id: { endsWith: requestId } }] },
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
  const targets = new Set<string>();
  for (const s of supers) if (s.phone) targets.add(s.phone);
  if (coop?.adminPhone) targets.add(coop.adminPhone);
  for (const to of targets) {
    await sendText({ to, text }).catch(() => {});
  }
}

async function isSuperAdminOf(phone: string, cooperativeId: string): Promise<boolean> {
  const member = await prisma.member.findFirst({ where: { phone, cooperativeId } });
  if (!member) return false;
  if (member.role === "superadmin") return true;
  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });
  return coop?.adminPhone === phone;
}