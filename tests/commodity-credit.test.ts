import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import {
  commoditySchemesEnabled,
  getCreditPositionForMember,
} from "../src/services/commodity-credit.js";

async function wipe(table: string) {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  } catch {}
}

beforeEach(async () => {
  vi.stubEnv("COMMODITY_SCHEMES_ENABLED", "1");
  vi.stubEnv("COMMODITY_CREDIT_MULTIPLIER", "3");
  for (const t of [
    "deductionShortfall",
    "deductionItem",
    "deductionBatch",
    "commoditySubscription",
    "commoditySchemeItem",
    "commodityScheme",
    "loan",
    "wallet",
    "member",
    "cooperative",
  ]) {
    await wipe(t);
  }
});

afterEach(() => vi.unstubAllEnvs());

async function seed() {
  const coop = await prisma.cooperative.create({
    data: { name: "Credit Coop", code: `CR${Date.now()}${Math.floor(Math.random() * 1000)}` },
  });
  const member = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: "2348090000010",
      name: "Credit Member",
      code: "CRM010",
      role: "member",
      status: "active",
      wallet: { create: {} },
    },
  });
  return { coop, member };
}

async function seedSchedule(coopId: string, memberId: string, amount: number) {
  return prisma.deductionBatch.create({
    data: {
      cooperativeId: coopId,
      ref: `DED-${new Date().toISOString().slice(0, 7)}-CRD1`,
      totalAmount: amount,
      sourceFileKey: "uploads/payslip.xlsx",
      sourceFileName: "payslip.xlsx",
      createdById: memberId,
      items: { create: [{ memberId, kind: "savings", amount }] },
    },
  });
}

describe("commodity credit position", () => {
  it("is disabled unless the env flag is set", () => {
    vi.stubEnv("COMMODITY_SCHEMES_ENABLED", "0");
    expect(commoditySchemesEnabled()).toBe(false);
  });

  it("uses the uploaded schedule times the multiplier", async () => {
    const { coop, member } = await seed();
    await seedSchedule(coop.id, member.id, 10_000);
    const pos = await getCreditPositionForMember(member.id, coop.id);
    expect(pos.expectedKobo).toBe(10_000);
    expect(pos.capKobo).toBe(30_000);
    expect(pos.availableKobo).toBe(30_000);
    expect(pos.blockedReason).toBeNull();
  });

  it("subtracts commodity loans and open reservations", async () => {
    const { coop, member } = await seed();
    await seedSchedule(coop.id, member.id, 10_000);
    await prisma.loan.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        amount: 5_000,
        balance: 5_000,
        tenureMonths: 3,
        monthlyPayment: 1_667,
        status: "disbursed",
        kind: "commodity",
      },
    });
    const scheme = await prisma.commodityScheme.create({
      data: {
        cooperativeId: coop.id,
        reference: "SCH-C1",
        name: "Credit scheme",
        opensAt: new Date("2026-11-01"),
        closesAt: new Date("2026-11-20"),
        status: "open",
        createdById: member.id,
      },
    });
    const item = await prisma.commoditySchemeItem.create({
      data: {
        schemeId: scheme.id,
        name: "Oil",
        unitLabel: "jerrycan",
        unitCostKobo: 1_000,
        memberPriceKobo: 2_000,
      },
    });
    await prisma.commoditySubscription.create({
      data: {
        reference: "CS-C1",
        cooperativeId: coop.id,
        schemeId: scheme.id,
        itemId: item.id,
        memberId: member.id,
        qty: 1,
        unitPriceKobo: 2_000,
        totalKobo: 2_000,
        months: 3,
      },
    });
    const pos = await getCreditPositionForMember(member.id, coop.id);
    expect(pos.committedKobo).toBe(7_000);
    expect(pos.availableKobo).toBe(23_000);
  });

  it("blocks on an open shortfall and explains why", async () => {
    const { coop, member } = await seed();
    const batch = await seedSchedule(coop.id, member.id, 10_000);
    await prisma.deductionShortfall.create({
      data: { cooperativeId: coop.id, batchId: batch.id, memberId: member.id, amount: 500 },
    });
    const pos = await getCreditPositionForMember(member.id, coop.id);
    expect(pos.availableKobo).toBe(0);
    expect(pos.blockedReason).toContain("shortfall");
  });

  it("blocks when no schedule was uploaded this month", async () => {
    const { coop, member } = await seed();
    const pos = await getCreditPositionForMember(member.id, coop.id);
    expect(pos.availableKobo).toBe(0);
    expect(pos.blockedReason).toContain("No payroll schedule");
  });
});
