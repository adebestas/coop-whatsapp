import { prisma } from "../lib/prisma.js";
import { sendText } from "../lib/messaging.js";
import { resolveProvider } from "./payments/index.js";
import { formatBalance } from "./cooperative.js";

export interface DisbursementResult {
  ok: boolean;
  status: "successful" | "failed" | "name_mismatch";
  message: string;
}

/**
 * Disburse an approved loan to the member's bank account.
 *
 * The provider resolves the account holder's name and we compare it against
 * the member's registered name. If the names don't match, the money is NOT
 * sent — the loan stays approved but un-disbursed so an admin can follow up.
 */
export async function disburseLoan(loanId: string): Promise<DisbursementResult> {
  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { member: true },
  });
  if (!loan) return { ok: false, status: "failed", message: "Loan not found." };
  if (loan.status !== "approved") {
    return { ok: false, status: "failed", message: `Loan must be approved before disbursement (current: ${loan.status}).` };
  }

  const { member } = loan;

  if (!loan.bankAccountNumber || !loan.bankCode) {
    const msg = `Loan *${loan.id.slice(-6)}* is approved but has no bank details, so nothing was paid out.`;
    await prisma.loan.update({
      where: { id: loan.id },
      data: { disbursementStatus: "failed", disbursementError: "missing bank details" },
    });
    await notify(member, msg);
    return { ok: false, status: "failed", message: msg };
  }

  const provider = resolveProvider();
  if (!provider.resolveAccount) {
    const msg = `Loan *${loan.id.slice(-6)}* can't be disbursed: payment provider has no account resolver.`;
    await prisma.loan.update({
      where: { id: loan.id },
      data: { disbursementStatus: "failed", disbursementError: "provider has no resolver" },
    });
    await notify(member, msg);
    return { ok: false, status: "failed", message: msg };
  }

  // 1. Verify the account holder's name matches the member's registered name.
  const resolved = await provider.resolveAccount({ accountNumber: loan.bankAccountNumber, bankCode: loan.bankCode });
  if (!resolved.ok || !resolved.name) {
    const msg = `Loan *${loan.id.slice(-6)}* was NOT paid out: could not verify the account (${resolved.error ?? "unknown error"}). Admin should check the bank details.`;
    await prisma.loan.update({
      where: { id: loan.id },
      data: { disbursementStatus: "failed", disbursementError: resolved.error ?? "resolution failed" },
    });
    await notify(member, msg);
    return { ok: false, status: "failed", message: msg };
  }

  if (!namesMatch(resolved.name, member.name)) {
    const msg = `Loan *${loan.id.slice(-6)}* was NOT paid out: the account name (*${resolved.name}*) does not match the member's registered name (*${member.name}*). Admin must verify before disbursing.`;
    await prisma.loan.update({
      where: { id: loan.id },
      data: { disbursementStatus: "name_mismatch", disbursementError: `account name is "${resolved.name}"` },
    });
    await notify(member, msg);
    return { ok: false, status: "name_mismatch", message: msg };
  }

  // 2. Names match — send the money.
  const reference = `LND-${loan.id.slice(-8)}-${Date.now()}`;
  try {
    if (provider.payout) {
      const result = await provider.payout({
        amount: loan.amount,
        bankAccountNumber: loan.bankAccountNumber,
        bankCode: loan.bankCode,
        recipientName: member.name,
        reference,
      });
      if (!result.ok) {
        const msg = `Loan *${loan.id.slice(-6)}* was NOT paid out: provider error (${result.error ?? "unknown"}). No money moved.`;
        await prisma.loan.update({
          where: { id: loan.id },
          data: { disbursementStatus: "failed", disbursementError: result.error ?? "payout failed" },
        });
        await notify(member, msg);
        return { ok: false, status: "failed", message: msg };
      }

      await prisma.payout.create({
        data: {
          amount: loan.amount,
          reference,
          status: "successful",
          provider: provider.name,
          providerRef: result.providerRef,
          note: `Loan disbursement to ${member.name}`,
          memberId: member.id,
          cooperativeId: member.cooperativeId,
        },
      });
    }

    await prisma.loan.update({
      where: { id: loan.id },
      data: {
        status: "disbursed",
        disbursedAt: new Date(),
        disbursementStatus: "successful",
        disbursementError: null,
      },
    });

    const msg = `🎉 Your loan of *${formatBalance(loan.amount)}* was approved and *disbursed* to your bank account (${loan.bankName ?? loan.bankCode} ****${loan.bankAccountNumber.slice(-4)}).`;
    await notify(member, msg);
    return { ok: true, status: "successful", message: msg };
  } catch (err: any) {
    const msg = `Loan *${loan.id.slice(-6)}* could not be disbursed right now (${err?.message ?? "provider error"}). No money moved.`;
    await prisma.loan.update({
      where: { id: loan.id },
      data: { disbursementStatus: "failed", disbursementError: err?.message ?? "payout threw" },
    });
    await notify(member, msg);
    return { ok: false, status: "failed", message: msg };
  }
}

/** Loose first+last name match: case-insensitive, ignoring punctuation/middle words. */
export function namesMatch(accountName: string, registeredName: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const a = new Set(norm(accountName).split(" ").filter(Boolean));
  const b = new Set(norm(registeredName).split(" ").filter(Boolean));
  // Every word in the registered name must appear in the account name.
  for (const word of b) {
    if (!a.has(word)) return false;
  }
  return a.size > 0;
}

async function notify(member: { phone: string }, text: string): Promise<void> {
  await sendText({ to: member.phone, text }).catch(() => {});
}