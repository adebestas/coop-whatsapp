import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../tests/setup.js";

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

describe("commodity credit schema", () => {
  it("stores a scheme with items, a subscription and a shortfall", async () => {
    const coop = await prisma.cooperative.create({
      data: { name: "Schema Coop", code: `SC${Date.now()}` },
    });
    const member = await prisma.member.create({
      data: {
        cooperativeId: coop.id,
        phone: "2348090000001",
        name: "Schema Member",
        code: "SCM001",
        role: "member",
        status: "active",
      },
    });
    const scheme = await prisma.commodityScheme.create({
      data: {
        cooperativeId: coop.id,
        reference: "SCH-TEST-1",
        name: "Christmas 2026",
        opensAt: new Date("2026-11-01"),
        closesAt: new Date("2026-11-20"),
        createdById: member.id,
      },
    });
    const item = await prisma.commoditySchemeItem.create({
      data: {
        schemeId: scheme.id,
        name: "Rice 50kg",
        unitLabel: "bag",
        unitCostKobo: 8_000_000,
        memberPriceKobo: 8_500_000,
        totalUnits: 100,
      },
    });
    const sub = await prisma.commoditySubscription.create({
      data: {
        reference: "CS-TEST-1",
        cooperativeId: coop.id,
        schemeId: scheme.id,
        itemId: item.id,
        memberId: member.id,
        qty: 2,
        unitPriceKobo: 8_500_000,
        totalKobo: 17_000_000,
        months: 3,
      },
    });
    expect(sub.status).toBe("reserved");
    expect(scheme.status).toBe("draft");

    const batch = await prisma.deductionBatch.create({
      data: {
        cooperativeId: coop.id,
        ref: "DED-SCHEMA-1",
        totalAmount: 1000,
        createdById: member.id,
      },
    });
    const shortfall = await prisma.deductionShortfall.create({
      data: {
        cooperativeId: coop.id,
        batchId: batch.id,
        memberId: member.id,
        amount: 500,
      },
    });
    expect(shortfall.status).toBe("open");

    await expect(
      prisma.commoditySubscription.create({
        data: {
          reference: "CS-TEST-1",
          cooperativeId: coop.id,
          schemeId: scheme.id,
          itemId: item.id,
          memberId: member.id,
          qty: 1,
          unitPriceKobo: 1,
          totalKobo: 1,
          months: 3,
        },
      }),
    ).rejects.toThrow();
  });
});
