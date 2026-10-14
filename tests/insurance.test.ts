import { beforeEach, describe, expect, it } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";

beforeEach(async () => {
  await cleanupDatabase();
});

describe("InsurancePolicy", () => {
  it("creates a policy with the expected fields and defaults", async () => {
    const coop = await createTestCoop("INS1");
    const member = await createTestMember(coop.id, { phone: "2348011110001" });

    const policy = await prisma.insurancePolicy.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        productCode: "supercare",
        planCode: "plus",
        premiumKobo: 50000,
        coverageKobo: 500000,
      },
    });

    expect(policy.id).toBeTruthy();
    expect(policy.cooperativeId).toBe(coop.id);
    expect(policy.memberId).toBe(member.id);
    expect(policy.productCode).toBe("supercare");
    expect(policy.planCode).toBe("plus");
    expect(policy.status).toBe("active");
    expect(policy.premiumKobo).toBe(50000);
    expect(policy.coverageKobo).toBe(500000);
    expect(policy.startDate).toBeInstanceOf(Date);
    expect(policy.endDate).toBeNull();
    expect(policy.autoRenew).toBe(true);
    expect(policy.cubecoverPolicyId).toBeNull();
    expect(policy.createdAt).toBeInstanceOf(Date);
    expect(policy.updatedAt).toBeInstanceOf(Date);
  });

  it("allows setting optional fields and a custom status", async () => {
    const coop = await createTestCoop("INS2");
    const member = await createTestMember(coop.id, { phone: "2348011110002" });

    const policy = await prisma.insurancePolicy.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        productCode: "superfix",
        planCode: "elite",
        status: "lapsed",
        cubecoverPolicyId: "cc-pol-123",
        premiumKobo: 100000,
        coverageKobo: 1000000,
        startDate: new Date("2026-01-01T00:00:00Z"),
        endDate: new Date("2027-01-01T00:00:00Z"),
        autoRenew: false,
      },
    });

    expect(policy.status).toBe("lapsed");
    expect(policy.cubecoverPolicyId).toBe("cc-pol-123");
    expect(policy.autoRenew).toBe(false);
    expect(policy.startDate).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(policy.endDate).toEqual(new Date("2027-01-01T00:00:00Z"));
  });

  it("is queryable via the member and cooperative relations", async () => {
    const coop = await createTestCoop("INS3");
    const member = await createTestMember(coop.id, { phone: "2348011110003" });

    await prisma.insurancePolicy.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        productCode: "supercare",
        planCode: "basic",
        premiumKobo: 25000,
        coverageKobo: 250000,
      },
    });

    const found = await prisma.member.findUniqueOrThrow({
      where: { id: member.id },
      include: { insurancePolicies: true },
    });
    expect(found.insurancePolicies).toHaveLength(1);
    expect(found.insurancePolicies[0].productCode).toBe("supercare");

    const coopPolicies = await prisma.cooperative.findUniqueOrThrow({
      where: { id: coop.id },
      include: { insurancePolicies: true },
    });
    expect(coopPolicies.insurancePolicies).toHaveLength(1);
  });
});

describe("InsuranceClaim", () => {
  it("creates a claim linked to a policy and verifies fields", async () => {
    const coop = await createTestCoop("INS4");
    const member = await createTestMember(coop.id, { phone: "2348011110004" });

    const policy = await prisma.insurancePolicy.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        productCode: "supercare",
        planCode: "plus",
        premiumKobo: 50000,
        coverageKobo: 500000,
      },
    });

    const claim = await prisma.insuranceClaim.create({
      data: {
        cooperativeId: coop.id,
        policyId: policy.id,
        memberId: member.id,
        claimType: "accident",
        amountKobo: 200000,
        description: "Hospital bill for broken arm",
        documents: ["receipt-1", "receipt-2"],
      },
    });

    expect(claim.id).toBeTruthy();
    expect(claim.cooperativeId).toBe(coop.id);
    expect(claim.policyId).toBe(policy.id);
    expect(claim.memberId).toBe(member.id);
    expect(claim.claimType).toBe("accident");
    expect(claim.amountKobo).toBe(200000);
    expect(claim.status).toBe("pending");
    expect(claim.description).toBe("Hospital bill for broken arm");
    expect(claim.documents).toEqual(["receipt-1", "receipt-2"]);
    expect(claim.payoutKobo).toBeNull();
    expect(claim.payoutDestination).toBeNull();
    expect(claim.cubecoverClaimId).toBeNull();
    expect(claim.createdAt).toBeInstanceOf(Date);
    expect(claim.processedAt).toBeNull();
    expect(claim.paidAt).toBeNull();
  });

  it("allows setting payout fields and status transitions", async () => {
    const coop = await createTestCoop("INS5");
    const member = await createTestMember(coop.id, { phone: "2348011110005" });

    const policy = await prisma.insurancePolicy.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        productCode: "superfix",
        planCode: "standard",
        premiumKobo: 75000,
        coverageKobo: 750000,
      },
    });

    const claim = await prisma.insuranceClaim.create({
      data: {
        cooperativeId: coop.id,
        policyId: policy.id,
        memberId: member.id,
        claimType: "theft",
        amountKobo: 300000,
        status: "paid",
        cubecoverClaimId: "cc-claim-456",
        payoutKobo: 300000,
        payoutDestination: "bank",
        processedAt: new Date("2026-06-01T00:00:00Z"),
        paidAt: new Date("2026-06-02T00:00:00Z"),
      },
    });

    expect(claim.status).toBe("paid");
    expect(claim.cubecoverClaimId).toBe("cc-claim-456");
    expect(claim.payoutKobo).toBe(300000);
    expect(claim.payoutDestination).toBe("bank");
    expect(claim.processedAt).toEqual(new Date("2026-06-01T00:00:00Z"));
    expect(claim.paidAt).toEqual(new Date("2026-06-02T00:00:00Z"));
  });

  it("is queryable via the policy relation", async () => {
    const coop = await createTestCoop("INS6");
    const member = await createTestMember(coop.id, { phone: "2348011110006" });

    const policy = await prisma.insurancePolicy.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        productCode: "supercare",
        planCode: "basic",
        premiumKobo: 25000,
        coverageKobo: 250000,
      },
    });

    await prisma.insuranceClaim.create({
      data: {
        cooperativeId: coop.id,
        policyId: policy.id,
        memberId: member.id,
        claimType: "illness",
        amountKobo: 100000,
      },
    });

    const found = await prisma.insurancePolicy.findUniqueOrThrow({
      where: { id: policy.id },
      include: { claims: true },
    });
    expect(found.claims).toHaveLength(1);
    expect(found.claims[0].claimType).toBe("illness");
  });
});
