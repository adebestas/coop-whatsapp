import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../tests/setup.js";
import { attributeShortfall, rollForwardItem, priorityRank } from "../src/services/deductions.js";

const SUPER = "2348090000300";

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
    data: { name: "Short Coop", code: `SH${Date.now()}` },
  });
  const superM = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: SUPER,
      name: "Super",
      code: "SS900",
      role: "superadmin",
      status: "active",
      wallet: { create: {} },
    },
  });
  const member = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: "2348090000301",
      name: "Short Member",
      code: "SM900",
      role: "member",
      status: "active",
      wallet: { create: {} },
    },
  });
  const batch = await prisma.deductionBatch.create({
    data: {
      cooperativeId: coop.id,
      ref: "DED-SHORT-1",
      status: "reconciled",
      totalAmount: 1_000,
      reconciledAmount: 600,
      createdById: superM.id,
    },
  });
  return { coop, superM, member, batch };
}

describe("deduction shortfalls", () => {
  it("ranks loan before commodity before savings", () => {
    expect(priorityRank("loan")).toBeLessThan(priorityRank("commodity"));
    expect(priorityRank("commodity")).toBeLessThan(priorityRank("savings"));
  });

  it("attributes an explicit shortfall", async () => {
    const { batch, member } = await seed();
    const res = await attributeShortfall(SUPER, batch.ref, member.code, 400, "employer skipped");
    expect(res.ok).toBe(true);
    const row = await prisma.deductionShortfall.findFirst();
    expect(row!.amount).toBe(400);
    expect(row!.status).toBe("open");
    expect(row!.reason).toBe("employer skipped");
  });

  it("attributes proportionally when no member is named", async () => {
    const { batch, member } = await seed();
    await prisma.deductionItem.create({
      data: { batchId: batch.id, memberId: member.id, kind: "savings", amount: 1_000 },
    });
    const res = await attributeShortfall(SUPER, batch.ref, "all", "all");
    expect(res.ok).toBe(true);
    const row = await prisma.deductionShortfall.findFirst();
    expect(row!.amount).toBe(400);
  });

  it("waives a shortfall and releases the block", async () => {
    const { batch, member } = await seed();
    await attributeShortfall(SUPER, batch.ref, member.code, 400);
    const res = await attributeShortfall(SUPER, batch.ref, member.code, "waive");
    expect(res.ok).toBe(true);
    const row = await prisma.deductionShortfall.findFirst();
    expect(row!.status).toBe("waived");
  });

  it("rolls an unpaid item into a draft batch for the next period once", async () => {
    const { batch, member } = await seed();
    const item = await prisma.deductionItem.create({
      data: { batchId: batch.id, memberId: member.id, kind: "savings", amount: 1_000 },
    });
    const first = await rollForwardItem(batch.id, item.id, member.id);
    expect(first.batchId).not.toBe(batch.id);
    expect(first.amount).toBe(1_000);
    const original = await prisma.deductionItem.findUnique({ where: { id: item.id } });
    expect(original!.status).toBe("rolled");
    await expect(rollForwardItem(batch.id, item.id, member.id)).rejects.toThrow();
  });
});
