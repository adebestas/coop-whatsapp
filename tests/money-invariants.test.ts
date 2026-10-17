import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanupDatabase } from "../tests/setup.js";
import { toKobo, toNaira, forProvider } from "../src/lib/money.js";
import { roundMoney } from "../src/services/money.js";
import { postJournal, trialBalance } from "../src/services/journal.js";
import { recordLedger, computePnl } from "../src/services/ledger.js";
import { paystackAdapter } from "../src/services/payments/paystack.js";
import { monnifyAdapter } from "../src/services/payments/monnify.js";
import { namesMatch } from "../src/services/disbursements.js";

let coopCounter = 0;
async function makeCoop() {
  const code = `INV${Date.now()}${coopCounter++}`;
  return prisma.cooperative.create({ data: { name: "Invariant Coop", code } });
}

beforeEach(async () => {
  await cleanupDatabase();
});

describe("kobo is the single on-chain unit", () => {
  it("converts and rounds without floating point drift", () => {
    expect(toKobo(1000.5)).toBe(100050);
    expect(toNaira(100050)).toBe(1000.5);
    expect(roundMoney(100.5)).toBe(101); // nearest kobo up
    expect(roundMoney(100.4)).toBe(100);
    expect(roundMoney(Number.NaN)).toBe(0);
    expect(roundMoney(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("converts to provider currency ONLY at the wire boundary", () => {
    // Paystack expects kobo → passthrough.
    expect(forProvider(100050, "paystack")).toBe(100050);
    // Monnify expects naira → divide by 100.
    expect(forProvider(100050, "monnify")).toBe(1000.5);
  });
});

describe("double-entry journal invariants", () => {
  it("posts balanced entries and keeps a balanced trial balance", async () => {
    const coop = await makeCoop();
    await postJournal({
      cooperativeId: coop.id,
      txRef: "T1",
      description: "sale",
      postings: [
        { account: "assets:bank", direction: "DEBIT", amount: 1000 },
        { account: "income:sales", direction: "CREDIT", amount: 1000 },
      ],
    });
    const tb = await trialBalance(coop.id);
    expect(tb.balanced).toBe(true);
    expect(tb.debits).toBe(1000);
    expect(tb.credits).toBe(1000);
  });

  it("rejects unbalanced entries and never half-posts", async () => {
    const coop = await makeCoop();
    const res = await postJournal({
      cooperativeId: coop.id,
      txRef: "T2",
      description: "unbalanced",
      postings: [
        { account: "assets:bank", direction: "DEBIT", amount: 1000 },
        { account: "income:sales", direction: "CREDIT", amount: 999 },
      ],
    });
    expect(res.posted).toBe(false);
    expect(res.reason).toBe("unbalanced");
    expect(await prisma.journalEntry.count({ where: { cooperativeId: coop.id } })).toBe(0);
  });

  it("rejects entries with fewer than 2 legs", async () => {
    const coop = await makeCoop();
    const res = await postJournal({
      cooperativeId: coop.id,
      txRef: "T3",
      description: "single leg",
      postings: [{ account: "assets:bank", direction: "DEBIT", amount: 1000 }],
    });
    expect(res.posted).toBe(false);
    expect(res.reason).toBe("unbalanced");
  });

  it("is idempotent on txRef and throws when throwOnDuplicate is set", async () => {
    const coop = await makeCoop();
    const legs = {
      cooperativeId: coop.id,
      txRef: "DUP-1",
      description: "dup",
      postings: [
        { account: "assets:bank", direction: "DEBIT" as const, amount: 500 },
        { account: "income:x", direction: "CREDIT" as const, amount: 500 },
      ],
    };
    const first = await postJournal(legs);
    expect(first.posted).toBe(true);

    const second = await postJournal(legs);
    expect(second.posted).toBe(false);
    expect(second.reason).toBe("duplicate");

    await expect(postJournal({ ...legs, throwOnDuplicate: true })).rejects.toThrow();
    expect(await prisma.journalEntry.count({ where: { cooperativeId: coop.id } })).toBe(1);
  });
});

describe("ledger P&L invariants", () => {
  it("computes net profit from income minus expense, excluding appropriation and balance_sheet", async () => {
    const coop = await makeCoop();
    await recordLedger({
      cooperativeId: coop.id,
      type: "income",
      category: "interest",
      amount: 1200000,
      note: "interest",
    });
    await recordLedger({
      cooperativeId: coop.id,
      type: "expense",
      category: "stipend",
      amount: 200000,
      note: "stipend",
    });
    // These must NOT move the P&L.
    await recordLedger({
      cooperativeId: coop.id,
      type: "appropriation",
      category: "dividend",
      amount: 500000,
      note: "dividend",
    });
    await recordLedger({
      cooperativeId: coop.id,
      type: "balance_sheet",
      category: "assets:loan_portfolio",
      amount: 900000,
      note: "loan book",
    });

    const pnl = await computePnl(coop.id);
    expect(pnl.totalIncome).toBe(1200000);
    expect(pnl.totalExpense).toBe(200000);
    expect(pnl.netProfit).toBe(1000000);

    // Every ledger write posted balanced journal legs.
    const tb = await trialBalance(coop.id);
    expect(tb.balanced).toBe(true);
  });

  it("forces dividend categories into the appropriation type", async () => {
    const coop = await makeCoop();
    await recordLedger({
      cooperativeId: coop.id,
      type: "income",
      category: "dividend",
      amount: 500000,
      note: "bug check",
    });
    const entry = await prisma.ledgerEntry.findFirst({
      where: { cooperativeId: coop.id, category: "dividend" },
    });
    expect(entry!.type).toBe("appropriation");
  });
});

describe("provider payload shape invariants", () => {
  it("Paystack parseNotification keeps amounts in kobo and rejects non-credit events", () => {
    const credit = paystackAdapter.parseNotification({
      event: "charge.success",
      data: {
        id: 999,
        status: "success",
        amount: 500,
        account: { number: "VA-1" },
        currency: "NGN",
      },
    });
    expect(credit).not.toBeNull();
    expect(credit!.amount).toBe(500); // kobo passthrough
    expect(credit!.transactionId).toBe("999");
    expect(credit!.accountNumber).toBe("VA-1");
    expect(credit!.status).toBe("successful");

    expect(paystackAdapter.parseNotification({ event: "charge.failed", data: {} })).toBeNull();
    expect(
      paystackAdapter.parseNotification({
        event: "charge.success",
        data: { status: "pending", amount: 500 },
      }),
    ).toBeNull();
  });

  it("Monnify parseNotification converts naira to kobo", () => {
    const credit = monnifyAdapter.parseNotification({
      eventType: "SUCCESSFUL_TRANSACTION",
      eventData: {
        transactionReference: "MNF-1",
        amountPaid: 1000.5, // naira
        destinationAccountInformation: { accountNumber: "VA-2" },
        currencyCode: "NGN",
      },
    });
    expect(credit).not.toBeNull();
    expect(credit!.amount).toBe(100050); // naira → kobo
    expect(credit!.accountNumber).toBe("VA-2");

    expect(
      monnifyAdapter.parseNotification({ eventType: "FAILED_TRANSACTION", eventData: {} }),
    ).toBeNull();
  });
});

describe("account name validation", () => {
  it("requires every registered name word and tolerates at most one extra word", () => {
    expect(namesMatch("John Smith", "John Smith")).toBe(true);
    expect(namesMatch("JOHN SMITH", "john smith")).toBe(true); // case-insensitive
    expect(namesMatch("Smith, John", "John Smith")).toBe(true); // punctuation ignored, order-free
    expect(namesMatch("John Ola Smith", "John Smith")).toBe(true); // +1 extra word allowed
    expect(namesMatch("John Ola Abimbola Smith", "John Smith")).toBe(false); // +2 extra words
    expect(namesMatch("Peter Jones", "John Smith")).toBe(false); // missing words
    expect(namesMatch("", "John Smith")).toBe(false); // empty account
  });
});
