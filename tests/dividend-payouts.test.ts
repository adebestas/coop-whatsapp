import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { prisma, cleanupDatabase } from "./setup.js";
import { paymentState } from "./payment-state.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { recordLedger } from "../src/services/ledger.js";
import { trialBalance, getBankAccountBalance } from "../src/services/journal.js";
import {
  distributeDividend,
  applyDividendPayoutUpdate,
  dividendPayoutRef,
  previewDividendRun,
} from "../src/services/dividends.js";
import { handleAwaitingInput } from "../src/services/handlers/session.js";

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: `Div Coop ${code}`, code } });
}

async function makeMember(
  coopId: string,
  opts: { role?: string; totalSaved?: number; bank?: boolean; name?: string } = {},
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  const totalSaved = opts.totalSaved ?? 0;
  const bank = opts.bank ?? true;
  return prisma.member.create({
    data: {
      code,
      phone: `2348${Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)}`,
      name: opts.name ?? `Div Member ${code}`,
      cooperativeId: coopId,
      role: opts.role ?? "member",
      status: "active",
      pin: hashPin("1234"),
      ...(bank ? { bankAccountNumber: "0123456789", bankCode: "058", bankName: "GTBank" } : {}),
      wallet: { create: { balance: totalSaved, totalSaved } },
    },
    include: { wallet: true },
  });
}

/** Seed profit (income ledger) which also funds the bank float. */
async function seedProfit(coopId: string, amount = 1_000_000) {
  await recordLedger({
    cooperativeId: coopId,
    type: "income",
    category: "interest",
    amount,
    note: "Test profit",
    reference: `TEST-${Date.now()}`,
    fundType: "operational",
  });
}

beforeEach(async () => {
  await cleanupDatabase();
  vi.clearAllMocks();
  paymentState.resolveFails = false;
  paymentState.payoutFails = false;
});

// Leave no Payout/DividendEntry rows behind for the next file's manual cleanup
// (those rows carry FK links that require an order-sensitive delete).
afterAll(async () => {
  await cleanupDatabase();
});

describe("dividend direct-to-bank distribution", () => {
  it("pays members to their bank and keeps the books balanced", async () => {
    const coop = await makeCoop("DIV1");
    const admin = await makeMember(coop.id, { role: "superadmin" });
    const NAME = "Test Member";
    const a = await makeMember(coop.id, { totalSaved: 100_000, name: NAME });
    const b = await makeMember(coop.id, { totalSaved: 100_000, name: NAME });
    paymentState.resolveName = NAME;
    await seedProfit(coop.id, 1_000_000);

    const result = await distributeDividend(admin.phone, 20);
    expect(result.ok).toBe(true);
    expect(result.settled).toBe(2);

    const entries = await prisma.dividendEntry.findMany({
      where: { dividendId: result.dividendId! },
      orderBy: { memberId: "asc" },
    });
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.status).toBe("settled");
      expect(e.payoutId).not.toBeNull();
      expect(e.amount % 1).toBe(0); // integer kobo
    }
    // Payout created with the deterministic key.
    for (const m of [a, b]) {
      const p = await prisma.payout.findUnique({
        where: { idempotencyKey: dividendPayoutRef(result.dividendId!, m.id) },
      });
      expect(p).not.toBeNull();
    }

    const tb = await trialBalance(coop.id);
    expect(tb.balanced).toBe(true);
  });

  it("holds members without a verified bank account as a payable", async () => {
    const coop = await makeCoop("DIV2");
    const admin = await makeMember(coop.id, { role: "superadmin" });
    const withBank = await makeMember(coop.id, { totalSaved: 100_000 });
    const noBank = await makeMember(coop.id, { totalSaved: 100_000, bank: false });
    paymentState.resolveName = withBank.name;
    await seedProfit(coop.id, 1_000_000);

    const result = await distributeDividend(admin.phone, 20);
    expect(result.ok).toBe(true);
    expect(result.settled).toBe(1);
    expect(result.held).toBe(1);

    const held = await prisma.dividendEntry.findFirstOrThrow({
      where: { dividendId: result.dividendId!, memberId: noBank.id },
    });
    expect(held.status).toBe("pending");
    expect(held.failureReason).toMatch(/bank account/i);
    expect(withBank).toBeTruthy();

    // No payout for the held member.
    const heldPayout = await prisma.payout.findUnique({
      where: { idempotencyKey: dividendPayoutRef(result.dividendId!, noBank.id) },
    });
    expect(heldPayout).toBeNull();
    expect((await trialBalance(coop.id)).balanced).toBe(true);
  });

  it("refuses the run when the bank float is insufficient", async () => {
    const coop = await makeCoop("DIV3");
    const admin = await makeMember(coop.id, { role: "superadmin" });
    await makeMember(coop.id, { totalSaved: 100_000 });
    // Profit is high but no money actually sits in the bank (no income ledger).
    await prisma.ledgerEntry.create({
      data: {
        cooperativeId: coop.id,
        type: "income",
        category: "interest",
        amount: 1_000_000,
        note: "paper profit only",
        fundType: "operational",
      },
    });

    const result = await distributeDividend(admin.phone, 20);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Insufficient bank float/i);
    expect(await prisma.dividend.count({ where: { cooperativeId: coop.id } })).toBe(0);
  });

  it("reverses the journal when a payout is confirmed failed", async () => {
    const coop = await makeCoop("DIV4");
    const admin = await makeMember(coop.id, { role: "superadmin" });
    const member = await makeMember(coop.id, { totalSaved: 100_000 });
    paymentState.resolveName = member.name;
    await seedProfit(coop.id, 1_000_000);

    paymentState.payoutFails = true; // provider confirms no money moved

    const result = await distributeDividend(admin.phone, 20);
    expect(result.ok).toBe(true);
    expect(result.failed).toBe(1);
    expect(result.settled).toBe(0);

    const entry = await prisma.dividendEntry.findFirstOrThrow({
      where: { dividendId: result.dividendId! },
    });
    expect(entry.status).toBe("failed");

    // A counter-balancing journal exists and the books still balance.
    const rev = await prisma.journalEntry.findUnique({
      where: { txRef: `DIV-REV-${result.dividendId}-${entry.memberId}` },
      include: { postings: true },
    });
    expect(rev).not.toBeNull();
    const debits = rev!.postings
      .filter((p) => p.direction === "DEBIT")
      .reduce((s, p) => s + p.amount, 0);
    const credits = rev!.postings
      .filter((p) => p.direction === "CREDIT")
      .reduce((s, p) => s + p.amount, 0);
    expect(debits).toBe(credits);

    expect((await trialBalance(coop.id)).balanced).toBe(true);
  });

  it("settles a processing entry from a transfer.success callback", async () => {
    const coop = await makeCoop("DIV5");
    const admin = await makeMember(coop.id, { role: "superadmin" });
    const member = await makeMember(coop.id, { totalSaved: 100_000 });
    await seedProfit(coop.id, 1_000_000);

    // Force an "unsure" outcome so the entry stays processing.
    const originalPayout = paymentState.payoutFails;
    paymentState.payoutFails = false;
    // Simulate a stuck processing entry directly.
    const div = await prisma.dividend.create({
      data: {
        cooperativeId: coop.id,
        reference: `DIV-MANUAL-${Date.now()}`,
        rate: 20,
        totalPool: 10_000,
        status: "distributing",
        entries: { create: [{ memberId: member.id, amount: 10_000, status: "processing" }] },
      },
      include: { entries: true },
    });
    const ref = dividendPayoutRef(div.id, member.id);
    const payout = await prisma.payout.create({
      data: {
        amount: 10_000,
        reference: ref,
        idempotencyKey: ref,
        status: "pending",
        provider: "monnify",
        memberId: member.id,
        cooperativeId: coop.id,
        dividendEntry: { connect: { id: div.entries[0].id } },
      },
    });
    expect(payout.id).toBeTruthy();
    paymentState.payoutFails = originalPayout;

    const applied = await applyDividendPayoutUpdate({
      provider: "monnify",
      reference: ref,
      status: "successful",
    });
    expect(applied).toEqual({ handled: true, action: "settled" });

    const e = await prisma.dividendEntry.findUniqueOrThrow({ where: { id: div.entries[0].id } });
    expect(e.status).toBe("settled");

    // Idempotent on second delivery.
    await applyDividendPayoutUpdate({ provider: "monnify", reference: ref, status: "successful" });
    const e2 = await prisma.dividendEntry.findUniqueOrThrow({ where: { id: div.entries[0].id } });
    expect(e2.status).toBe("settled");
    expect(admin).toBeTruthy();
  });

  it("requires an explicit CONFIRM token before any payout (state-machine guardrail)", async () => {
    const coop = await makeCoop("DIV7");
    const admin = await makeMember(coop.id, { role: "superadmin" });
    const member = await makeMember(coop.id, { totalSaved: 100_000 });
    paymentState.resolveName = member.name;
    await seedProfit(coop.id, 1_000_000);

    // Preview must NOT pay.
    const preview = await previewDividendRun(admin.phone, 20);
    expect(preview.ok).toBe(true);
    expect(preview.confirmToken).toBe("CONFIRM 20");
    expect(preview.payoutCount).toBe(1);
    expect(await prisma.dividend.count()).toBe(0);

    // A casual "yes" cancels — nothing is paid.
    await prisma.session.create({
      data: {
        phone: admin.phone,
        state: "awaiting_dividend_confirm",
        data: JSON.stringify({ dividendRate: 20 }),
      },
    });
    await handleAwaitingInput(
      admin.phone,
      "awaiting_dividend_confirm",
      "yes",
      JSON.stringify({ dividendRate: 20 }),
      {},
    );
    expect(await prisma.dividend.count()).toBe(0);

    // The exact token executes the run.
    await prisma.session.update({
      where: { phone: admin.phone },
      data: { state: "awaiting_dividend_confirm", data: JSON.stringify({ dividendRate: 20 }) },
    });
    await handleAwaitingInput(
      admin.phone,
      "awaiting_dividend_confirm",
      "CONFIRM 20",
      JSON.stringify({ dividendRate: 20 }),
      {},
    );
    expect(await prisma.dividend.count()).toBe(1);
    const entries = await prisma.dividendEntry.findMany();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("settled");
  });

  it("reduces the journal-derived bank float by the amount paid", async () => {
    const coop = await makeCoop("DIV6");
    const admin = await makeMember(coop.id, { role: "superadmin" });
    const member = await makeMember(coop.id, { totalSaved: 100_000 });
    paymentState.resolveName = member.name;
    await seedProfit(coop.id, 1_000_000);

    const before = await getBankAccountBalance(coop.id);
    const result = await distributeDividend(admin.phone, 20);
    expect(result.ok).toBe(true);
    const after = await getBankAccountBalance(coop.id);
    expect(after).toBe(before - result.totalPool!);
  });
});
