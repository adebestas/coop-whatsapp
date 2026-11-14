import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  prisma,
  createTestApp,
  createTestCoop,
  createTestMember,
  cleanupDatabase,
} from "./setup.js";
import { resetRateLimitPrefix } from "../src/lib/cache.js";

beforeEach(async () => {
  await cleanupDatabase();
  await resetRateLimitPrefix("login:");
});
afterAll(cleanupDatabase);

async function loginAs(app: FastifyInstance, phone: string, pin = "1234"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    payload: { phone, pin },
  });
  expect(res.statusCode).toBe(200);
  const cookie = String(res.headers["set-cookie"]);
  return `coop_token=${cookie.split("coop_token=")[1].split(";")[0]}`;
}

async function seedPolicy(coopId: string, memberId: string, productCode = "supercare") {
  return prisma.insurancePolicy.create({
    data: {
      cooperativeId: coopId,
      memberId,
      productCode,
      planCode: "basic",
      status: "active",
      cubecoverPolicyId: `cc_pol_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      premiumKobo: 50000,
      coverageKobo: 5000000,
    },
  });
}

async function seedClaim(
  coopId: string,
  memberId: string,
  policyId: string,
  overrides: Partial<{ status: string; amountKobo: number; cubecoverClaimId: string }> = {},
) {
  return prisma.insuranceClaim.create({
    data: {
      cooperativeId: coopId,
      memberId,
      policyId,
      claimType: "hospitalisation",
      amountKobo: overrides.amountKobo ?? 500000,
      status: overrides.status ?? "approved",
      cubecoverClaimId:
        overrides.cubecoverClaimId ??
        `cc_clm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      description: "Test claim",
    },
  });
}

describe("admin insurance policies", () => {
  it("lists policies with member names, scoped to the cooperative", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("INS1");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348092000001",
      pin: "1234",
    });
    const member = await createTestMember(coop.id, { phone: "2348092000002", name: "Bola Ade" });
    const policy = await seedPolicy(coop.id, member.id);
    const claim = await seedClaim(coop.id, member.id, policy.id);

    const otherCoop = await createTestCoop("INS2");
    const otherAdmin = await createTestMember(otherCoop.id, { phone: "2348092000003" });
    const otherMember = await createTestMember(otherCoop.id, { phone: "2348092000004" });
    const otherPolicy = await seedPolicy(otherCoop.id, otherMember.id);
    await seedClaim(otherCoop.id, otherMember.id, otherPolicy.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/insurance/policies",
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.policies).toHaveLength(1);
    expect(body.policies[0]).toMatchObject({
      id: policy.id,
      memberName: "Bola Ade",
      productCode: "supercare",
      planCode: "basic",
      status: "active",
      premiumKobo: 50000,
      coverageKobo: 5000000,
      claimCount: 1,
    });
  });
});

describe("admin insurance claims", () => {
  it("lists claims with member and policy details, scoped to the cooperative", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("INC1");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348092000011",
      pin: "1234",
    });
    const member = await createTestMember(coop.id, { phone: "2348092000012", name: "Chidi Eze" });
    const policy = await seedPolicy(coop.id, member.id);
    const claim = await seedClaim(coop.id, member.id, policy.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/insurance/claims",
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0]).toMatchObject({
      id: claim.id,
      memberName: "Chidi Eze",
      productCode: "supercare",
      claimType: "hospitalisation",
      amountKobo: 500000,
      status: "approved",
    });
  });

  it("filters claims by status", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("INC2");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348092000021",
      pin: "1234",
    });
    const member = await createTestMember(coop.id, { phone: "2348092000022" });
    const policy = await seedPolicy(coop.id, member.id);
    await seedClaim(coop.id, member.id, policy.id, { status: "approved" });
    await seedClaim(coop.id, member.id, policy.id, { status: "rejected" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/insurance/claims?status=rejected",
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().claims).toHaveLength(1);
    expect(res.json().claims[0].status).toBe("rejected");
  });

  it("lets a super admin approve a claim and credits the member's wallet", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("INC3");
    const admin = await createTestMember(coop.id, {
      role: "superadmin",
      phone: "2348092000031",
      pin: "1234",
    });
    const member = await createTestMember(coop.id, { phone: "2348092000032" });
    const policy = await seedPolicy(coop.id, member.id);
    const claim = await seedClaim(coop.id, member.id, policy.id, { amountKobo: 250000 });

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/insurance/claims/${claim.id}/approve`,
      headers: {
        cookie: await loginAs(app, admin.phone),
        "x-requested-with": "XMLHttpRequest",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    const updated = await prisma.insuranceClaim.findUnique({ where: { id: claim.id } });
    expect(updated?.status).toBe("paid");
    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet?.balance).toBe(250000);
  });

  it("refuses a non-super admin from approving a claim", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("INC4");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348092000041",
      pin: "1234",
    });
    const member = await createTestMember(coop.id, { phone: "2348092000042" });
    const policy = await seedPolicy(coop.id, member.id);
    const claim = await seedClaim(coop.id, member.id, policy.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/insurance/claims/${claim.id}/approve`,
      headers: {
        cookie: await loginAs(app, admin.phone),
        "x-requested-with": "XMLHttpRequest",
      },
    });

    expect(res.statusCode).toBe(403);
    const updated = await prisma.insuranceClaim.findUnique({ where: { id: claim.id } });
    expect(updated?.status).toBe("approved");
  });

  it("rejects a claim and audits the decision", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("INC5");
    const admin = await createTestMember(coop.id, {
      role: "superadmin",
      phone: "2348092000051",
      pin: "1234",
    });
    const member = await createTestMember(coop.id, { phone: "2348092000052" });
    const policy = await seedPolicy(coop.id, member.id);
    const claim = await seedClaim(coop.id, member.id, policy.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/insurance/claims/${claim.id}/reject`,
      headers: {
        cookie: await loginAs(app, admin.phone),
        "x-requested-with": "XMLHttpRequest",
      },
    });

    expect(res.statusCode).toBe(200);
    const updated = await prisma.insuranceClaim.findUnique({ where: { id: claim.id } });
    expect(updated?.status).toBe("rejected");
    const auditRow = await prisma.auditLog.findFirst({
      where: { cooperativeId: coop.id, action: "insurance.claim.reject" },
    });
    expect(auditRow).toBeTruthy();
  });

  it("cannot approve a claim belonging to another cooperative", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("INC6");
    const admin = await createTestMember(coop.id, {
      role: "superadmin",
      phone: "2348092000061",
      pin: "1234",
    });
    const otherCoop = await createTestCoop("INC7");
    const otherMember = await createTestMember(otherCoop.id, { phone: "2348092000062" });
    const otherPolicy = await seedPolicy(otherCoop.id, otherMember.id);
    const otherClaim = await seedClaim(otherCoop.id, otherMember.id, otherPolicy.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/insurance/claims/${otherClaim.id}/approve`,
      headers: {
        cookie: await loginAs(app, admin.phone),
        "x-requested-with": "XMLHttpRequest",
      },
    });

    expect(res.statusCode).toBe(404);
    const unchanged = await prisma.insuranceClaim.findUnique({ where: { id: otherClaim.id } });
    expect(unchanged?.status).toBe("approved");
  });
});
