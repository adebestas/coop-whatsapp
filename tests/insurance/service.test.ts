import { describe, it, expect, vi } from "vitest";
import { prisma } from "../../src/lib/prisma.js";
import {
  InsuranceService,
  approveInsuranceClaim,
  rejectInsuranceClaim,
  listMemberInsuranceClaims,
  payoutInsuranceClaim,
} from "../../src/services/insurance/index.js";

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

describe("insurance accounting & idempotency", () => {
  it("books premiums to an agent liability account, not coop income", async () => {
    const { coop, member } = await seedCoopMember(10_000);
    const svc = new InsuranceService({ prisma, cubecover: fakeCubeCover() });
    await svc.purchasePlan(coop.id, member.id, "supercare", "standard");

    const entry = await prisma.journalEntry.findFirst({
      where: { cooperativeId: coop.id, txRef: { startsWith: "insurance_premium_" } },
      include: { postings: true },
    });
    expect(entry).not.toBeNull();
    const accounts = entry!.postings.map((p) => p.account);
    expect(accounts).toContain("liabilities:insurance_payable");
    expect(accounts).not.toContain("income:insurance_premium");
  });

  it("does not double-charge the premium for the same reference", async () => {
    const { coop, member } = await seedCoopMember(10_000);
    const svc = new InsuranceService({ prisma, cubecover: fakeCubeCover() }) as unknown as {
      chargePremium: (
        cooperativeId: string,
        memberId: string,
        amount: number,
        ref: string,
        description: string,
      ) => Promise<void>;
    };
    const ref = `idem_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await svc.chargePremium(coop.id, member.id, 5_000, ref, "d");
    await svc.chargePremium(coop.id, member.id, 5_000, ref, "d");

    expect((await prisma.wallet.findUnique({ where: { memberId: member.id } }))?.balance).toBe(5_000);
    expect(
      await prisma.journalEntry.count({ where: { txRef: `insurance_premium_${ref}` } }),
    ).toBe(1);
  });
});

describe("insurance claim payout safety", () => {
  async function seedClaim(opts: { amountKobo: number; payoutKobo?: number; status?: string }) {
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
        cubecoverPolicyId: `cc-p-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      },
    });
    const claim = await prisma.insuranceClaim.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        policyId: policy.id,
        claimType: "hospicash",
        amountKobo: opts.amountKobo,
        payoutKobo: opts.payoutKobo ?? null,
        cubecoverClaimId: `cc-c-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        status: opts.status ?? "approved",
      },
    });
    return { coop, member, claim };
  }

  it("never credits more than the submitted amount", async () => {
    const { member, claim } = await seedClaim({ amountKobo: 60_000, payoutKobo: 999_999 });
    await payoutInsuranceClaim(claim.cubecoverClaimId!);
    expect((await prisma.wallet.findUnique({ where: { memberId: member.id } }))?.balance).toBe(60_000);
  });

  it("credits the provider's partial approved amount when smaller", async () => {
    const { member, claim } = await seedClaim({ amountKobo: 60_000, payoutKobo: 30_000 });
    await payoutInsuranceClaim(claim.cubecoverClaimId!);
    expect((await prisma.wallet.findUnique({ where: { memberId: member.id } }))?.balance).toBe(30_000);
  });

  it("refuses to pay a rejected claim", async () => {
    const { member, claim } = await seedClaim({ amountKobo: 60_000, status: "rejected" });
    const res = await payoutInsuranceClaim(claim.cubecoverClaimId!);
    expect(res.ok).toBe(false);
    expect((await prisma.wallet.findUnique({ where: { memberId: member.id } }))?.balance).toBe(0);
  });

  it("scopes admin claim actions to the caller's cooperative (no IDOR)", async () => {
    const { claim } = await seedClaim({ amountKobo: 60_000 });
    const other = await seedCoopMember(0);

    const approve = await approveInsuranceClaim(claim.id, other.coop.id);
    expect(approve.message).toMatch(/No insurance claim found/i);
    const reject = await rejectInsuranceClaim(claim.id, other.coop.id);
    expect(reject.message).toMatch(/No insurance claim found/i);
    expect((await prisma.insuranceClaim.findUnique({ where: { id: claim.id } }))?.status).toBe(
      "approved",
    );

    const list = await listMemberInsuranceClaims("UNKNOWN", other.coop.id);
    expect(list.message).toMatch(/No member found/i);

    // The owning cooperative can still act on it.
    const ok = await approveInsuranceClaim(claim.id, claim.cooperativeId);
    expect(ok.message).toMatch(/paid/i);
  });
});
