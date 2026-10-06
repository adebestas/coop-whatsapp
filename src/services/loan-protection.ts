import type { Prisma } from "@prisma/client";
import { prisma, withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import { postJournal } from "./journal.js";
import { roundMoney } from "./money.js";

type Client = Prisma.TransactionClient | typeof prisma;

/**
 * Write off every outstanding, protected loan of a member against the
 * cooperative's self-insured loan-protection fund. Runs as part of the death
 * claim payout, BEFORE the family's savings are paid out, so a deceased
 * member's dependants are not chased for a loan the fund already covers.
 *
 * Only loans that actually carry an active `LoanProtection` row are touched.
 * For each such loan with status "disbursed" | "partial" and balance > 0:
 *   - the loan is settled (status "paid", balance 0);
 *   - its LoanProtection row is marked "claimed" with the written-off amount;
 *   - a balanced journal entry is posted: DEBIT liabilities:loan_protection_fund
 *     for the part the fund covers, DEBIT expense:loan_protection_claim for any
 *     shortfall (absorbed as a cooperative expense), CREDIT
 *     assets:loan_portfolio for the whole outstanding balance;
 *   - the cooperative's protection-fund balance is decremented atomically by
 *     the amount the fund covered (never below zero).
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
        protection: { isNot: null },
      },
      include: { protection: true },
    });

    let total = 0;
    for (const loan of loans) {
      const protection = loan.protection;
      if (!protection) continue;

      const outstanding = roundMoney(loan.balance);
      if (outstanding <= 0) continue;

      const coop = await client.cooperative.findUnique({
        where: { id: cooperativeId },
        select: { protectionFundBalance: true },
      });
      const fundBalance = Math.max(0, coop?.protectionFundBalance ?? 0);
      // Whatever the fund cannot cover is absorbed as a cooperative expense.
      const fromFund = Math.min(outstanding, fundBalance);
      const fromExpense = outstanding - fromFund;

      await client.loan.update({
        where: { id: loan.id },
        data: { status: "paid", balance: 0 },
      });

      await client.loanProtection.update({
        where: { id: protection.id },
        data: {
          status: "claimed",
          claimId,
          writtenOff: outstanding,
          claimedAt: new Date(),
        },
      });

      const postings = [
        { account: "assets:loan_portfolio", direction: "CREDIT" as const, amount: outstanding, memberId },
        ...(fromFund > 0
          ? [
              {
                account: "liabilities:loan_protection_fund",
                direction: "DEBIT" as const,
                amount: fromFund,
                memberId,
              },
            ]
          : []),
        ...(fromExpense > 0
          ? [
              {
                account: "expense:loan_protection_claim",
                direction: "DEBIT" as const,
                amount: fromExpense,
                memberId,
              },
            ]
          : []),
      ];

      await postJournal(
        {
          cooperativeId,
          txRef: `LOAN-PROT-CLAIM-${claimId}-${loan.id}`,
          description: `Loan protection write-off for loan ${loan.id.slice(-6)} on claim ${claimId.slice(-6)}`,
          postings,
        },
        client as never,
      );

      if (fromFund > 0) {
        // Atomic decrement — guarded so the scalar can never go negative.
        await client.cooperative.updateMany({
          where: { id: cooperativeId, protectionFundBalance: { gte: fromFund } },
          data: { protectionFundBalance: { decrement: fromFund } },
        });
      }

      total = roundMoney(total + outstanding);
    }

    return total;
  };

  if (tx) return run(tx);
  return withTx(async (t) => {
    await setCoopContext(t as never, cooperativeId);
    return run(t);
  });
}
