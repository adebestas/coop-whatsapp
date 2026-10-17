import { prisma } from "../../lib/prisma.js";
import { roundMoney } from "../money.js";

export interface FederationPostingInput {
  account: string;
  direction: "DEBIT" | "CREDIT";
  amount: number;
  cooperativeId?: string | null;
}

export async function postFederationJournal(
  opts: {
    federationId: string;
    txRef: string;
    description: string;
    currency: string;
    postings: FederationPostingInput[];
  },
  client: Pick<typeof prisma, "federationLedgerEntry"> = prisma,
): Promise<{ posted: boolean; reason?: "unbalanced" | "duplicate" }> {
  const postings = opts.postings.map((p) => ({ ...p, amount: roundMoney(p.amount) }));
  if (postings.length < 2) return { posted: false, reason: "unbalanced" };
  const totals = postings.reduce(
    (a, p) =>
      p.direction === "DEBIT"
        ? { ...a, d: roundMoney(a.d + p.amount) }
        : { ...a, c: roundMoney(a.c + p.amount) },
    { d: 0, c: 0 },
  );
  if (totals.d !== totals.c || totals.d <= 0) return { posted: false, reason: "unbalanced" };
  try {
    await client.federationLedgerEntry.create({
      data: {
        federationId: opts.federationId,
        txRef: opts.txRef,
        description: opts.description,
        currency: opts.currency,
        postings: {
          create: postings.map((p) => ({
            account: p.account,
            direction: p.direction,
            amount: p.amount,
            cooperativeId: p.cooperativeId ?? null,
          })),
        },
      },
    });
    return { posted: true };
  } catch (err: any) {
    if (err?.code === "P2002") return { posted: false, reason: "duplicate" };
    throw err;
  }
}
