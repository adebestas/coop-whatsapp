import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import { sendText } from "../src/lib/messaging.js";
import { generateMemberCode } from "../src/lib/security.js";
import { formatBalance, clearMemberCache } from "../src/services/cooperative.js";
import { recordLedger } from "../src/services/ledger.js";
import { calculateInterestPortion } from "../src/services/loans.js";
import { computeDividendCalculator } from "../src/services/dividends.js";

const PHONE = "2348072000001";
const PEER = "2348072000002";

async function wipe(table: string) {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  } catch {}
}

beforeEach(async () => {
  for (const table of [
    "shareTransaction",
    "shareAccount",
    "dividendEntry",
    "dividend",
    "ledgerEntry",
    "journalEntry",
    "loanRepayment",
    "loan",
    "wallet",
    "member",
    "cooperative",
    "session",
  ]) {
    await wipe(table);
  }
  clearMemberCache();
  vi.mocked(sendText).mockClear();
});

async function seed() {
  const coop = await prisma.cooperative.create({
    data: { name: "Calc Coop", code: `DC${Date.now()}${Math.floor(Math.random() * 1000)}` },
  });
  const member = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: PHONE,
      name: "Calc Member",
      code: generateMemberCode(),
      status: "active",
      consentAt: new Date(),
      wallet: { create: { totalSaved: 500_000, balance: 500_000 } },
      shareAccount: { create: { cooperativeId: coop.id, shares: 100, totalPaid: 500_000 } },
    },
  });
  await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: PEER,
      name: "Peer Member",
      code: generateMemberCode(),
      status: "active",
      consentAt: new Date(),
      wallet: { create: { totalSaved: 500_000 } },
      shareAccount: { create: { cooperativeId: coop.id, shares: 300, totalPaid: 1_500_000 } },
    },
  });
  await recordLedger({
    cooperativeId: coop.id,
    type: "income",
    category: "interest",
    amount: 10_000_000,
  });
  return { coop, member };
}

describe("dividendcalc projection", () => {
  it("splits the member pool 70/30 between shares and patronage", async () => {
    const { member } = await seed();
    const loan = await prisma.loan.create({
      data: {
        amount: 1_000_000,
        balance: 900_000,
        tenureMonths: 12,
        status: "disbursed",
        kind: "cash",
        memberId: member.id,
        cooperativeId: member.cooperativeId,
      },
    });
    await prisma.loanRepayment.create({
      data: { loanId: loan.id, amount: 100_000, paidAt: new Date() },
    });

    const result = await computeDividendCalculator(PHONE, 10);
    expect(result.ok).toBe(true);

    const interest = calculateInterestPortion(1_000_000, 12);
    expect(interest).toBeGreaterThan(0);

    const netProfit = 10_000_000;
    const distributable =
      netProfit -
      Math.floor(netProfit * 0.25) -
      Math.floor(netProfit * 0.1) -
      Math.floor(netProfit * 0.05);
    const pool = Math.round(distributable * 0.1);
    const sharePool = Math.round(pool * 0.7);
    const patronagePool = pool - sharePool;
    const shareDividend = Math.floor((100 / 400) * sharePool);

    expect(result.message).toContain("Rate: *10%*");
    expect(result.message).toContain(formatBalance(shareDividend));
    expect(result.message).toContain(formatBalance(patronagePool));
    expect(result.message).toContain("Share capital dividend");
    expect(result.message).toContain("Patronage rebate");
    expect(result.message).toContain("Projection only");
  });

  it("defaults to the last declared rate this year", async () => {
    const { coop } = await seed();
    await prisma.dividend.create({
      data: {
        cooperativeId: coop.id,
        reference: `DIV-${Date.now()}`,
        rate: 8,
        basis: "savings",
        totalPool: 0,
      },
    });

    const result = await computeDividendCalculator(PHONE);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Rate: *8%*");
    expect(result.message).toContain("last declared rate");
  });

  it("asks for a rate when nothing has been declared", async () => {
    await seed();
    const result = await computeDividendCalculator(PHONE);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("dividendcalc <rate%>");
  });

  it("rejects rates above the statutory cap", async () => {
    await seed();
    const result = await computeDividendCalculator(PHONE, 40);
    expect(result.ok).toBe(false);
  });
});
