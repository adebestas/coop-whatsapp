import { prisma } from "../lib/prisma.js";
import { postJournal } from "./journal.js";
import { roundMoney } from "./money.js";

export type LedgerType = "income" | "expense" | "appropriation";
export type LedgerCategory =
  | "interest"
  | "fine"
  | "admin_charge"
  | "guarantee_recovery"
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
}) {
  const amount = roundMoney(input.amount);
  if (amount <= 0) return;

  const fundType = input.fundType ?? "operational";

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
            { account: `appropriation:${input.category}`, direction: "DEBIT" as const, amount },
            { account: "equity:appropriations", direction: "CREDIT" as const, amount },
          ];

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
  // Non-blocking on duplicates here (callers that need strict idempotency
  // use postJournal directly with a deterministic txRef).
  await postJournalSafe({
    cooperativeId: input.cooperativeId,
    txRef: input.txRef,
    description: input.note ?? `${input.type}:${input.category}`,
    postings,
  });
}

/** Journal posting that never breaks the main write (best-effort parity). */
async function postJournalSafe(opts: {
  cooperativeId: string;
  txRef?: string;
  description: string;
  postings: Parameters<typeof postJournal>[0]["postings"];
}) {
  try {
    await postJournal({ ...opts, txRef: opts.txRef ?? `jr_${crypto.randomUUID()}`, description: opts.description });
  } catch (err) {
    console.error("[ledger] journal posting failed", err);
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
  const where: any = { cooperativeId, type: { in: ["income", "expense"] } };
  
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = startDate;
    if (endDate) where.createdAt.lte = endDate;
  }

  const entries = await prisma.ledgerEntry.findMany({
    where,
    select: { type: true, category: true, amount: true },
  });

  const incomeByCategory: Record<string, number> = {};
  const expenseByCategory: Record<string, number> = {};
  let totalIncome = 0;
  let totalExpense = 0;

  for (const e of entries) {
    const bucket = e.type === "income" ? incomeByCategory : expenseByCategory;
    bucket[e.category] = (bucket[e.category] ?? 0) + e.amount;
    if (e.type === "income") totalIncome += e.amount;
    else totalExpense += e.amount;
  }

  return {
    incomeByCategory,
    expenseByCategory,
    totalIncome: round2(totalIncome),
    totalExpense: round2(totalExpense),
    netProfit: round2(totalIncome - totalExpense),
    period: startDate || endDate ? { start: startDate ?? new Date(0), end: endDate ?? new Date() } : undefined,
  };
}

/** Get monthly summary for a given month (0-11) */
export async function getMonthlySummary(cooperativeId: string, year: number, month: number): Promise<PnlSummary> {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0, 23, 59, 59);
  return computePnl(cooperativeId, start, end);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
