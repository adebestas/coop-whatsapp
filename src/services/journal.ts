import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { roundMoney } from "./money.js";

export type PostingInput = {
  account: string;
  direction: "DEBIT" | "CREDIT";
  amount: number;
  memberId?: string | null;
};

/**
 * Double-entry journal. Every posting set MUST balance (sum of debits ==
 * sum of credits) and is idempotent on txRef — the same business event
 * (top-up, payout, fee) can never be booked twice even under retries or
 * concurrent deliveries (unique constraint on JournalEntry.txRef).
 *
 * With throwOnDuplicate, a duplicate txRef THROWS (P2002) instead of being
 * swallowed — use inside transactions where the duplicate must abort the
 * whole business write (e.g. wallet credits).
 *
 * Returns { posted: true } if written; { posted: false, reason } otherwise.
 */
export async function postJournal(
  opts: {
    cooperativeId: string;
    txRef?: string;
    description: string;
    postings: PostingInput[];
    throwOnDuplicate?: boolean;
  },
  client: Pick<typeof prisma, "journalEntry"> = prisma,
): Promise<{ posted: boolean; reason?: "unbalanced" | "duplicate"; entryId?: string }> {
  const postings = opts.postings.map((p) => ({
    ...p,
    amount: roundMoney(p.amount),
    memberId: p.memberId ?? null,
  }));

  if (postings.length < 2) {
    if (opts.throwOnDuplicate) throw new Error("journal posting unbalanced (<2 legs)");
    return { posted: false, reason: "unbalanced" };
  }

  const totals = postings.reduce(
    (acc, p) => {
      if (p.direction === "DEBIT") acc.d = roundMoney(acc.d + p.amount);
      else acc.c = roundMoney(acc.c + p.amount);
      return acc;
    },
    { d: 0, c: 0 },
  );
  // Balanced to the kobo — no half-posted entries ever reach the books.
  if (totals.d !== totals.c || totals.d <= 0) {
    if (opts.throwOnDuplicate) throw new Error(`journal posting unbalanced (D=${totals.d} C=${totals.c})`);
    return { posted: false, reason: "unbalanced" };
  }

  const txRef = opts.txRef ?? `jr_${randomUUID()}`;
  try {
    const entry = await client.journalEntry.create({
      data: {
        cooperativeId: opts.cooperativeId,
        txRef,
        description: opts.description,
        postings: {
          create: postings.map((p) => ({
            account: p.account,
            direction: p.direction,
            amount: p.amount,
            memberId: p.memberId,
          })),
        },
      },
    });
    return { posted: true, entryId: entry.id };
  } catch (err: any) {
    // P2002 unique violation on txRef => duplicate delivery.
    if (err?.code === "P2002") {
      if (opts.throwOnDuplicate) throw err;
      return { posted: false, reason: "duplicate" };
    }
    throw err;
  }
}

/** Trial balance: total debits must equal total credits per cooperative. */
export async function trialBalance(cooperativeId: string): Promise<{
  debits: number;
  credits: number;
  balanced: boolean;
}> {
  const rows = await prisma.posting.groupBy({
    by: ["direction"],
    where: { entry: { cooperativeId } },
    _sum: { amount: true },
  });
  const debits = roundMoney(rows.find((r) => r.direction === "DEBIT")?._sum.amount ?? 0);
  const credits = roundMoney(rows.find((r) => r.direction === "CREDIT")?._sum.amount ?? 0);
  return { debits, credits, balanced: debits === credits };
}
