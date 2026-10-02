import { beforeEach, describe, expect, it } from "vitest";
import { prisma, cleanupDatabase } from "../tests/setup.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { getFinancialMemory } from "../src/lib/ai-data.js";

beforeEach(async () => {
  await cleanupDatabase();
});

async function makeCoop() {
  return prisma.cooperative.create({ data: { name: "AI Coop", code: `AI${Date.now()}` } });
}

async function makeMember(phone: string, coopId: string) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  return prisma.member.create({
    data: {
      code,
      phone,
      name: "Memory Member",
      cooperativeId: coopId,
      pin: hashPin("1234"),
      wallet: { create: {} },
      consentAt: new Date(),
    },
    include: { wallet: true },
  });
}

describe("AI financial memory", () => {
  it("computes remaining borrow capacity as 2x savings minus outstanding loans", async () => {
    const coop = await makeCoop();
    const member = await makeMember("2348013000001", coop.id);

    // ₦100,000 saved.
    await prisma.wallet.update({
      where: { memberId: member.id },
      data: { balance: 10000000, totalSaved: 10000000 },
    });

    // One disbursed loan with ₦40,000 still outstanding.
    await prisma.loan.create({
      data: {
        memberId: member.id,
        cooperativeId: coop.id,
        amount: 4000000,
        balance: 4000000,
        tenureMonths: 6,
        interestRate: 8,
        status: "disbursed",
      },
    });

    const memory = await getFinancialMemory(member.id);
    expect(memory).not.toBeNull();
    // 2x savings (₦200,000) minus outstanding (₦40,000) = ₦160,000 borrow headroom.
    expect(memory!.maxAdditionalLoan).toBe(16000000);
    expect(memory!.outstandingLoanBalance).toBe(4000000);
    expect(memory!.totalSaved).toBe(10000000);
  });

  it("returns zero headroom when outstanding debt equals or exceeds 2x savings", async () => {
    const coop = await makeCoop();
    const member = await makeMember("2348013000002", coop.id);

    await prisma.wallet.update({
      where: { memberId: member.id },
      data: { balance: 5000000, totalSaved: 5000000 },
    });
    await prisma.loan.create({
      data: {
        memberId: member.id,
        cooperativeId: coop.id,
        amount: 15000000,
        balance: 15000000,
        tenureMonths: 6,
        status: "disbursed",
      },
    });

    const memory = await getFinancialMemory(member.id);
    expect(memory).not.toBeNull();
    expect(memory!.maxAdditionalLoan).toBe(0);
  });

  it("returns null for a non-existent member", async () => {
    expect(await getFinancialMemory("does-not-exist")).toBeNull();
  });
});
