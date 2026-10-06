import type { Prisma } from "@prisma/client";
import { prisma, withTx } from "../lib/prisma.js";
import { postJournal } from "./journal.js";
import { roundMoney } from "./money.js";

type Client = Prisma.TransactionClient | typeof prisma;

/**
 * Write off every outstanding, protected loan of a member against the
 * cooperative's self-insured loan-protection fund. Runs as part of the death
 * claim payout, BEFORE the family's savings are paid out, so a deceased
 * member's dependants are not chased for a loan the fund already covers.
 *
 * For each loan with status "disbursed" | "partial" and balance > 0:
 *   - the loan is settled (status "paid", balance 0);
 *   - its LoanProtection row is marked "claimed" with the written-off amount;
 *   - a balanced journal entry is posted: DEBIT liabilities:loan_protection_fund
 *     / CREDIT assets:loan_portfolio;
 *   - the cooperative's protection-fund balance is decremented by the amount.
 *
 * The fund is clamped at zero: if the outstanding balance exceeds the fund, the
 * excess is absorbed as a cooperative expense and never throws.
 *
 * Returns the total amount written off (kobo).
 */
export async function writeOffProtection(
  cooperativeId: string,
  memberId: string,
  claimId: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const run = async (client: Client): Promise<number> => {
    const loans = await client.loan.findMany({
      where: {
        cooperativeId,
        memberId,
        status: { in: ["disbursed", "partial"] },
        balance: { gt: 0 },
      },
      include: { protection: true },
    });

    let total = 0;
    for (const loan of loans) {
      const balance = roundMoney(loan.balance);
      if (balance <= 0) continue;

      await client.loan.update({
        where: { id: loan.id },
        data: { status: "paid", balance: 0 },
      });

      if (loan.protection) {
        await client.loanProtection.update({
          where: { id: loan.protection.id },
          data: {
            status: "claimed",
            claimId,
            writtenOff: balance,
            claimedAt: new Date(),
          },
        });
      }

      await postJournal(
        {
          cooperativeId,
          txRef: `LOAN-PROT-CLAIM-${claimId}-${loan.id}`,
          description: `Loan protection write-off for loan ${loan.id.slice(-6)} on claim ${claimId.slice(-6)}`,
          postings: [
            {
              account: "liabilities:loan_protection_fund",
              direction: "DEBIT",
              amount: balance,
              memberId: loan.memberId,
            },
            {
              account: "assets:loan_portfolio",
              direction: "CREDIT",
              amount: balance,
              memberId: loan.memberId,
            },
          ],
        },
        client as never,
      );

      total = roundMoney(total + balance);
    }

    if (total > 0) {
      const coop = await client.cooperative.findUnique({
        where: { id: cooperativeId },
        select: { protectionFundBalance: true },
      });
      // Clamp: never go negative. Any excess beyond the fund is a coop expense.
      const fund = Math.max(0, coop?.protectionFundBalance ?? 0);
      await client.cooperative.update({
        where: { id: cooperativeId },
        data: { protectionFundBalance: Math.max(0, fund - total) },
      });
    }

    return total;
  };

  if (tx) return run(tx);
  return withTx((t) => run(t));
}
