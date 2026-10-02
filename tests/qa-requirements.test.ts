import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanupDatabase } from "../tests/setup.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import {
  annualRateFor,
  calculateMonthlyPayment,
  totalRepayable,
  applyForLoan,
  LOAN_ADMIN_CHARGE,
} from "../src/services/loans.js";
import { getCoopConfig } from "../src/services/coop-config.js";
import { createContribution } from "../src/services/cooperative.js";
import { distributeDividend } from "../src/services/dividends.js";
import { recordLedger } from "../src/services/ledger.js";
import { withdrawLimit, requestWithdrawal } from "../src/services/withdrawals.js";

const PHONE = "2348010000999";

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: "QA Coop", code } });
}

async function makeMember(
  phone: string,
  coopId: string,
  opts: { role?: string; totalSaved?: number; balance?: number } = {},
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role: opts.role ?? "member",
      pin: hashPin("1234"),
      wallet: {
        create: { totalSaved: opts.totalSaved ?? 0, balance: opts.balance ?? 0 },
      },
    },
    include: { wallet: true },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanupDatabase();
});

describe("loan numeric rules", () => {
  it("prices interest as declining-balance APR tiers (not 10% flat), with the 10% ceiling on long tenures", () => {
    // Tiers per loans.ts — shorter tenures price below the 10% ceiling.
    expect(annualRateFor(3)).toBe(6);
    expect(annualRateFor(6)).toBe(8);
    expect(annualRateFor(9)).toBe(9);
    expect(annualRateFor(11)).toBe(10);
    expect(annualRateFor(12)).toBe(10);

    // Declining balance: total repayable is monthly-payment × tenure and is
    // always less than a flat 10% (₦1,000 × 1.10 = 110,000 kobo) yet > principal.
    const principal = 100000; // kobo = ₦1,000
    const total = totalRepayable(principal, 12);
    expect(total).toBe(calculateMonthlyPayment(principal, 12) * 12);
    expect(total).toBeGreaterThan(principal);
    expect(total).toBeLessThan(110000);
  });

  it("charges a flat ₦2,000 (200000 kobo) admin charge on every loan", async () => {
    expect(LOAN_ADMIN_CHARGE).toBe(200000); // ₦2,000 in kobo

    const coop = await makeCoop("LOAN01");
    const member = await makeMember(PHONE, coop.id, { totalSaved: 500000, balance: 500000 });
    const res = await applyForLoan(PHONE, 500000, 6); // ₦5,000, within 2x savings
    expect(res.ok).toBe(true);

    const loan = await prisma.loan.findUnique({ where: { id: res.loanId } });
    expect(loan!.adminCharge).toBe(200000);
  });

  it("rejects a loan when the member has no savings (2x ₦0 = ₦0)", async () => {
    const coop = await makeCoop("LOAN02");
    await makeMember(PHONE, coop.id, { totalSaved: 0, balance: 0 });
    const res = await applyForLoan(PHONE, 500000, 6);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("no savings yet");
  });
});

describe("minimum contribution", () => {
  it("defaults the public minimum contribution to ₦2,000 (200000 kobo) and enforces it", async () => {
    const coop = await makeCoop("CONT01");
    await makeMember(PHONE, coop.id);

    const config = await getCoopConfig(coop.id);
    expect(config.minContribution).toBe(200000); // ₦2,000

    // Below the minimum (₦1,000) is refused.
    const below = await createContribution(PHONE, 100000);
    expect(below.ok).toBe(false);
    expect(below.message).toContain("Minimum save");

    // At/above the minimum works.
    const at = await createContribution(PHONE, 200000);
    expect(at.ok).toBe(true);
  });
});

describe("reserve fund statutory deductions (20/2/5)", () => {
  it("deducts 20% reserve, 2% education, 5% development from net profit before dividends", async () => {
    const coop = await makeCoop("RESV01");
    await makeMember(PHONE, coop.id, { totalSaved: 1000000, balance: 1000000 });
    const superAdmin = await makeMember("2348098888888", coop.id, {
      role: "superadmin",
      totalSaved: 0,
    });

    // Net profit = 1,500,000 − 500,000 = 1,000,000 kobo (₦10,000).
    await recordLedger({
      cooperativeId: coop.id,
      type: "income",
      category: "interest",
      amount: 1500000,
      note: "interest",
    });
    await recordLedger({
      cooperativeId: coop.id,
      type: "expense",
      category: "operating_cost",
      amount: 500000,
      note: "expenses",
    });

    const result = await distributeDividend(superAdmin.phone, 10); // 10% of distributable profit
    expect(result.ok).toBe(true);

    // 20% × 1,000,000 = 200,000  |  2% = 20,000  |  5% = 50,000.
    const coopAfter = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(coopAfter!.reserveFundBalance).toBe(200000);

    const reserve = await prisma.reserveAllocation.findFirst({ where: { cooperativeId: coop.id } });
    const education = await prisma.educationFund.findFirst({ where: { cooperativeId: coop.id } });
    const development = await prisma.developmentFund.findFirst({
      where: { cooperativeId: coop.id },
    });
    expect(reserve!.amount).toBe(200000);
    expect(education!.amount).toBe(20000);
    expect(development!.amount).toBe(50000);
  });
});

describe("edge cases", () => {
  it("rejects a withdrawal when the balance is zero (45% of ₦0 = ₦0)", async () => {
    const coop = await makeCoop("EDGE01");
    const member = await makeMember(PHONE, coop.id, { balance: 0 });

    const limit = await withdrawLimit(PHONE);
    expect(limit).not.toBeNull();
    expect(limit!.max).toBe(0);

    // ₦6,000 passes the config min/max, but 45% of ₦0 is ₦0.
    const res = await requestWithdrawal(PHONE, 600000);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("at most");
    void member;
  });
});
