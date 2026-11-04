import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../tests/setup.js";
import { buildBatch } from "../src/services/deductions.js";

async function wipe(table: string) {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  } catch {}
}

beforeEach(async () => {
  for (const t of [
    "deductionShortfall",
    "deductionItem",
    "deductionBatch",
    "loanRepayment",
    "loan",
    "wallet",
    "member",
    "cooperative",
  ]) {
    await wipe(t);
  }
});

async function seed() {
  const coop = await prisma.cooperative.create({
    data: { name: "Payroll Coop", code: `PC${Date.now()}` },
  });
  const admin = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: "2348090000200",
      name: "Payroll Admin",
      code: "PA001",
      role: "admin",
      status: "active",
      monthlyDeduction: 10_000,
      wallet: { create: {} },
    },
  });
  return { coop, admin };
}

async function makeLoan(coopId: string, memberId: string, kind: string, balance: number) {
  return prisma.loan.create({
    data: {
      cooperativeId: coopId,
      memberId,
      amount: balance,
      balance,
      tenureMonths: 3,
      monthlyPayment: 2_000,
      status: "disbursed",
      kind,
    },
  });
}

describe("buildBatch commodity installments", () => {
  it("adds a commodity item and ignores shop loans", async () => {
    const { coop, admin } = await seed();
    await makeLoan(coop.id, admin.id, "shop", 5_000);
    const commodity = await makeLoan(coop.id, admin.id, "commodity", 6_000);
    const res = await buildBatch("2348090000200");
    expect(res.ok).toBe(true);
    const batch = await prisma.deductionBatch.findFirst({ include: { items: true } });
    const kinds = batch!.items.map((i) => i.kind).sort();
    expect(kinds).toEqual(["commodity", "savings"]);
    const commodityItem = batch!.items.find((i) => i.kind === "commodity")!;
    expect(commodityItem.loanId).toBe(commodity.id);
    expect(commodityItem.amount).toBe(2_000);
  });

  it("still creates a cash-loan item for kind cash", async () => {
    const { coop, admin } = await seed();
    await makeLoan(coop.id, admin.id, "cash", 6_000);
    await buildBatch("2348090000200");
    const batch = await prisma.deductionBatch.findFirst({ include: { items: true } });
    expect(batch!.items.map((i) => i.kind).sort()).toEqual(["loan", "savings"]);
  });
});
