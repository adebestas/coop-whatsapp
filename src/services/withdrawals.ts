import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { sendToBank } from "./disbursements.js";

/** Maximum share of savings a member can withdraw at once. */
export const WITHDRAW_LIMIT_RATIO = 0.45;

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

/**
 * Withdraw up to 45% of savings to the member's bank account.
 * The provider verifies the account holder's name matches the member's
 * registered name before any money moves.
 */
export async function withdrawToBank(
  phone: string,
  amount: number,
  bank?: { accountNumber: string; bankCode: string; bankName?: string },
): Promise<WithdrawResult> {
  const member = await prisma.member.findFirst({
    where: { phone },
    include: { wallet: true },
  });
  if (!member || !member.wallet) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };
  }

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

  const result = await sendToBank({
    memberId: member.id,
    amount,
    bankAccountNumber: accNo,
    bankCode,
    bankName: bankName ?? undefined,
    note: `Member withdrawal (45% of savings)`,
  });
  if (!result.ok) {
    return { ok: false, message: `Withdrawal not processed: ${result.message}` };
  }

  // Money moved — now deduct the wallet.
  await prisma.$transaction([
    prisma.wallet.update({
      where: { id: member.wallet.id },
      data: { balance: { decrement: amount } },
    }),
    prisma.member.update({
      where: { id: member.id },
      data: { bankAccountNumber: accNo, bankCode, bankName },
    }),
  ]);

  const newBalance = balance - amount;
  return {
    ok: true,
    message: `✅ Withdrew ${formatBalance(amount)} to your bank (${bankName ?? bankCode} ****${accNo.slice(-4)}).\nRemaining balance: ${formatBalance(newBalance)}.`,
  };
}