import { prisma } from "../lib/prisma.js";
import { postJournal } from "./journal.js";
import { roundMoney } from "./money.js";

export type LedgerType = "income" | "expense" | "appropriation";
export type LedgerCategory =
  | "interest"
  | "fine"
  | "admin_charge"
  | "guarantee_recovery"
  | "loan_repayment"
  | "salary"
  | "stipend"
  | "purchase"
  | "external_payment"
  | "dividend"
  | "withdrawal"
  | "other";

/**
 * Records the human-readable ledger entry AND the double-entry journal
 * posting behind it. The journal leg is idempotent when a txRef is supplied.
 */
export async function recordLedger(input: {
  cooperativeId: string;
  type: LedgerType;
  category: LedgerCategory;
  amount: number;
  note?: string;
  reference?: string;
  /** Optional deterministic journal key for idempotent posting. */
  txRef?: string;
  /** Fund segregation: member (trust), operational, or reserve. */
  fundType?: string;
  /** Optional transaction client for atomic operations. */
  tx?: Pick<typeof prisma, "ledgerEntry" | "journalEntry">;
}) {
  const amount = roundMoney(input.amount);
  if (amount <= 0) return;

  // Enforce: dividend-related categories must use "appropriation" type
  if (input.category.includes("dividend") && input.type !== "appropriation") {
    console.error(`[ledger] category "${input.category}" contains "dividend" but type is "${input.type}" — forcing type to "appropriation"`);
    input.type = "appropriation";
  }

  const fundType = input.fundType ?? "operational";
  const client = input.tx ?? prisma;

  // Double-entry mapping: money in/out of the cooperative bank account.
  const postings =
    input.type === "income"
      ? [
          { account: "assets:bank", direction: "DEBIT" as const, amount },
          { account: `income:${input.category}`, direction: "CREDIT" as const, amount },
        ]
      : input.type === "expense"
        ? [
            { account: `expense:${input.category}`, direction: "DEBIT" as const, amount },
            { account: "assets:bank", direction: "CREDIT" as const, amount },
          ]
        : [
            // Appropriation: debits a liability account (dividend payable) and
            // credits the bank account, representing a distribution of profits.
            // Using liabilities:dividend_payable instead of equity:retained_earnings
            // ensures the cooperative's obligation to pay is tracked until wallets
            // are actually credited.
            { account: "liabilities:dividend_payable", direction: "DEBIT" as const, amount },
            { account: "assets:bank", direction: "CREDIT" as const, amount },
          ];

  if (input.tx) {
    // Inside an interactive transaction — write directly using tx client
    await client.ledgerEntry.create({
      data: {
        cooperativeId: input.cooperativeId,
        type: input.type,
        category: input.category,
        amount,
        note: input.note,
        reference: input.reference,
        fundType,
      },
    });
  } else {
    // Standalone call — wrap in its own batch transaction
    await prisma.$transaction([
      prisma.ledgerEntry.create({
        data: {
          cooperativeId: input.cooperativeId,
          type: input.type,
          category: input.category,
          amount,
          note: input.note,
          reference: input.reference,
          fundType,
        },
      }),
    ]);
  }
  // Non-blocking on duplicates here (callers that need strict idempotency
  // use postJournal directly with a deterministic txRef).
  await postJournalSafe({
    cooperativeId: input.cooperativeId,
    txRef: input.txRef,
    description: input.note ?? `${input.type}:${input.category}`,
    postings,
  }, client);
}

/** Journal posting that never breaks the main write (best-effort parity). */
async function postJournalSafe(opts: {
  cooperativeId: string;
  txRef?: string;
  description: string;
  postings: Parameters<typeof postJournal>[0]["postings"];
}, client: Pick<typeof prisma, "journalEntry" | "ledgerEntry"> = prisma) {
  try {
    await postJournal({ ...opts, txRef: opts.txRef ?? `jr_${crypto.randomUUID()}`, description: opts.description }, client);
  } catch (err) {
    console.error("[ledger] journal posting failed", {
      cooperativeId: opts.cooperativeId,
      txRef: opts.txRef,
      description: opts.description,
      postings: opts.postings,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    try {
      await client.ledgerEntry.create({
        data: {
          cooperativeId: opts.cooperativeId,
          type: "expense",
          category: "journal_miss",
          amount: 0,
          note: `[JOURNAL_RECONCILIATION] ${opts.description} — txRef: ${opts.txRef ?? "none"} — error: ${err instanceof Error ? err.message : String(err)}`,
          fundType: "operational",
        },
      });
    } catch (reconErr) {
      console.error("[ledger] journal reconciliation record also failed", reconErr);
    }
  }
}

export type PnlSummary = {
  incomeByCategory: Record<string, number>;
  expenseByCategory: Record<string, number>;
  totalIncome: number;
  totalExpense: number;
  netProfit: number;
  period?: { start: Date; end: Date };
};

export async function computePnl(
  cooperativeId: string,
  startDate?: Date,
  endDate?: Date,
): Promise<PnlSummary> {
  const where: { cooperativeId: string; type: { in: ("income" | "expense")[] }; createdAt?: { gte?: Date; lte?: Date } } = {
    cooperativeId,
    type: { in: ["income", "expense"] },
  };
  
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = startDate;
    if (endDate) where.createdAt.lte = endDate;
  }

  const grouped = await prisma.ledgerEntry.groupBy({
    by: ['type', 'category'],
    where,
    _sum: { amount: true },
  });

  const incomeByCategory: Record<string, number> = {};
  const expenseByCategory: Record<string, number> = {};
  let totalIncome = 0;
  let totalExpense = 0;

  for (const g of grouped) {
    if (g.category === "journal_miss") continue;
    const amount = g._sum.amount ?? 0;
    if (g.type === "income") {
      incomeByCategory[g.category] = (incomeByCategory[g.category] ?? 0) + amount;
      totalIncome += amount;
    } else {
      expenseByCategory[g.category] = (expenseByCategory[g.category] ?? 0) + amount;
      totalExpense += amount;
    }
  }

  return {
    incomeByCategory,
    expenseByCategory,
    totalIncome: roundMoney(totalIncome),
    totalExpense: roundMoney(totalExpense),
    netProfit: roundMoney(totalIncome - totalExpense),
    period: startDate || endDate ? { start: startDate ?? new Date(0), end: endDate ?? new Date() } : undefined,
  };
}

/** Get monthly summary for a given month (0-11) */
export async function getMonthlySummary(cooperativeId: string, year: number, month: number): Promise<PnlSummary> {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0, 23, 59, 59);
  return computePnl(cooperativeId, start, end);
}
