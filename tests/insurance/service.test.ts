import { describe, it, expect, vi } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import { InsuranceService } from "../../src/services/insurance/index.js";

function fakeCubeCover(overrides: Record<string, unknown> = {}) {
  return {
    getProducts: vi.fn(async () => []),
    createQuote: vi.fn(async () => ({ quoteId: "q1", premiumKobo: 5000 })),
    purchasePolicy: vi.fn(async () => ({
      id: "cc-p1",
      productCode: "supercare",
      planCode: "standard",
      status: "active",
      startDate: new Date().toISOString(),
      coverageKobo: 6_000_000,
    })),
    cancelPolicy: vi.fn(async () => {}),
    renewPolicy: vi.fn(async () => ({
      id: "cc-p1",
      productCode: "supercare",
      planCode: "standard",
      status: "active",
      startDate: new Date().toISOString(),
      coverageKobo: 6_000_000,
    })),
    submitClaim: vi.fn(async () => ({
      id: "cc-c1",
      policyId: "cc-p1",
      claimType: "hospicash",
      amountKobo: 60_000,
      status: "pending",
    })),
    ...overrides,
  } as never;
}

async function seedCoopMember(balance: number) {
  const coop = await prisma.cooperative.create({
    data: {
      name: "Ins Coop",
      code: `IN${Date.now()}${Math.floor(Math.random() * 1e6)}`,
      currency: "NGN",
    },
  });
  const member = await prisma.member.create({
    data: {
      code: `M${Date.now()}${Math.floor(Math.random() * 1e6)}`,
      phone: `+234${Date.now()}${Math.floor(Math.random() * 1e3)}`,
      name: "Ada",
      cooperativeId: coop.id,
      wallet: { create: { balance } },
    },
  });
  return { coop, member };
}

describe("InsuranceService.purchasePlan", () => {
  it("charges the premium from the wallet", async () => {
    const { coop, member } = await seedCoopMember(10_000);
    const svc = new InsuranceService({ prisma, cubecover: fakeCubeCover() });
    await svc.purchasePlan(coop.id, member.id, "supercare", "standard");
    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet?.balance).toBe(5_000);
  });

  it("rejects when the wallet balance is insufficient and takes nothing", async () => {
    const { coop, member } = await seedCoopMember(1_000);
    const svc = new InsuranceService({ prisma, cubecover: fakeCubeCover() });
    await expect(svc.purchasePlan(coop.id, member.id, "supercare", "standard")).rejects.toThrow(
      "INSUFFICIENT_BALANCE",
    );
    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet?.balance).toBe(1_000);
  });

  it("refunds the premium when the provider purchase fails", async () => {
    const { coop, member } = await seedCoopMember(10_000);
    const cc = fakeCubeCover({
      purchasePolicy: vi.fn(async () => {
        throw new Error("provider down");
      }),
    });
    const svc = new InsuranceService({ prisma, cubecover: cc });
    await expect(svc.purchasePlan(coop.id, member.id, "supercare", "standard")).rejects.toThrow(
      "provider down",
    );
    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet?.balance).toBe(10_000);
  });
});

describe("InsuranceService.handleWebhook", () => {
  it("ignores an event with no data.id (does not mass-update)", async () => {
    const { coop, member } = await seedCoopMember(0);
    await prisma.insurancePolicy.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        productCode: "supercare",
        planCode: "standard",
        status: "active",
        premiumKobo: 5_000,
        coverageKobo: 6_000_000,
        cubecoverPolicyId: "cc-p1",
      },
    });
    const svc = new InsuranceService({ prisma, cubecover: fakeCubeCover() });
    await svc.handleWebhook("policy.cancelled", {});
    const p = await prisma.insurancePolicy.findFirst({ where: { cooperativeId: coop.id } });
    expect(p?.status).toBe("active");
  });

  it("credits the wallet on claim.paid", async () => {
    const { coop, member } = await seedCoopMember(0);
    const policy = await prisma.insurancePolicy.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        productCode: "supercare",
        planCode: "standard",
        status: "active",
        premiumKobo: 5_000,
        coverageKobo: 6_000_000,
        cubecoverPolicyId: "cc-p1",
      },
    });
    await prisma.insuranceClaim.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        policyId: policy.id,
        claimType: "hospicash",
        amountKobo: 60_000,
        cubecoverClaimId: "cc-c1",
        status: "approved",
      },
    });
    const svc = new InsuranceService({ prisma, cubecover: fakeCubeCover() });
    await svc.handleWebhook("claim.paid", { id: "cc-c1" });
    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet?.balance).toBe(60_000);
    const claim = await prisma.insuranceClaim.findFirst({ where: { cubecoverClaimId: "cc-c1" } });
    expect(claim?.status).toBe("paid");
  });
});
