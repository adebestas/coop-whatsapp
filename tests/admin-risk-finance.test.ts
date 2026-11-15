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

async function seedProvisionRun(coopId: string, createdById: string, period = "2026-01") {
  return prisma.provisionRun.create({
    data: {
      cooperativeId: coopId,
      period,
      totalProvision: 125000,
      createdById,
    },
  });
}

async function seedReconciliation(coopId: string, performedBy: string) {
  return prisma.reconciliationLog.create({
    data: {
      cooperativeId: coopId,
      totalWalletBalances: 1000000,
      bankBalance: 1000000,
      discrepancy: 0,
      status: "ok",
      performedBy,
      memberCount: 10,
      activeLoans: 2,
      activeLoanTotal: 500000,
      pendingWithdrawals: 0,
      pendingWithdrawalTotal: 0,
    },
  });
}

describe("admin provisions", () => {
  it("returns the provision balance and runs scoped to the cooperative", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("PRV1");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348095000001",
      pin: "1234",
    });
    await prisma.cooperative.update({
      where: { id: coop.id },
      data: { loanLossProvisionBalance: 250000 },
    });
    const run = await seedProvisionRun(coop.id, admin.id);

    const otherCoop = await createTestCoop("PRV2");
    const otherAdmin = await createTestMember(otherCoop.id, { phone: "2348095000002" });
    await seedProvisionRun(otherCoop.id, otherAdmin.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/provisions",
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.balance).toBe(250000);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      id: run.id,
      period: "2026-01",
      totalProvision: 125000,
      entryCount: 0,
    });
  });
});

describe("admin reconciliation log", () => {
  it("lists reconciliation runs scoped to the cooperative", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("REC1");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348095000011",
      pin: "1234",
    });
    const log = await seedReconciliation(coop.id, admin.phone);

    const otherCoop = await createTestCoop("REC2");
    await seedReconciliation(otherCoop.id, "2348000000000");

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/reconciliation",
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]).toMatchObject({
      id: log.id,
      status: "ok",
      totalWalletBalances: 1000000,
      discrepancy: 0,
    });
  });
});

describe("admin referrals", () => {
  it("lists referrals and withdrawals with a status summary", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("REF1");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348095000021",
      pin: "1234",
    });
    const referrer = await createTestMember(coop.id, { phone: "2348095000022", name: "Referrer" });
    const referred = await createTestMember(coop.id, { phone: "2348095000023", name: "Referred" });
    await prisma.referral.create({
      data: {
        cooperativeId: coop.id,
        referrerId: referrer.id,
        referredMemberId: referred.id,
        code: "REFCODE",
        status: "rewarded",
        rewardType: "wallet",
        rewardAmount: 50000,
        rewardedAt: new Date(),
      },
    });
    await prisma.referralWithdrawal.create({
      data: {
        cooperativeId: coop.id,
        memberId: referrer.id,
        amount: 20000,
        destination: "wallet",
        status: "paid",
        paidAt: new Date(),
      },
    });

    const otherCoop = await createTestCoop("REF2");
    const o1 = await createTestMember(otherCoop.id, { phone: "2348095000024" });
    const o2 = await createTestMember(otherCoop.id, { phone: "2348095000025" });
    await prisma.referral.create({
      data: {
        cooperativeId: otherCoop.id,
        referrerId: o1.id,
        referredMemberId: o2.id,
        code: "OTHER",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/referrals",
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.referrals).toHaveLength(1);
    expect(body.referrals[0]).toMatchObject({
      referrerName: "Referrer",
      referredName: "Referred",
      status: "rewarded",
      rewardAmount: 50000,
    });
    expect(body.withdrawals).toHaveLength(1);
    expect(body.withdrawals[0]).toMatchObject({ amount: 20000, status: "paid" });
    expect(body.summary).toMatchObject({ total: 1, rewarded: 1, pending: 0, qualified: 0 });
  });
});

describe("admin refunds", () => {
  it("lists refund requests scoped to the cooperative", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("RFD1");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348095000031",
      pin: "1234",
    });
    const member = await createTestMember(coop.id, {
      phone: "2348095000032",
      name: "Refund Member",
    });
    const refund = await prisma.refundRequest.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        amount: 75000,
        reason: "Double payment",
        recommendedById: admin.id,
        status: "pending",
      },
    });

    const otherCoop = await createTestCoop("RFD2");
    const otherAdmin = await createTestMember(otherCoop.id, { phone: "2348095000033" });
    const otherMember = await createTestMember(otherCoop.id, { phone: "2348095000034" });
    await prisma.refundRequest.create({
      data: {
        cooperativeId: otherCoop.id,
        memberId: otherMember.id,
        amount: 1000,
        reason: "Other",
        recommendedById: otherAdmin.id,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/refunds",
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.refunds).toHaveLength(1);
    expect(body.refunds[0]).toMatchObject({
      id: refund.id,
      memberName: "Refund Member",
      amount: 75000,
      reason: "Double payment",
      status: "pending",
    });
  });

  it("lets a super admin reject a pending refund", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("RFD3");
    const admin = await createTestMember(coop.id, {
      role: "superadmin",
      phone: "2348095000041",
      pin: "1234",
    });
    const member = await createTestMember(coop.id, { phone: "2348095000042" });
    const refund = await prisma.refundRequest.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        amount: 5000,
        reason: "Duplicate",
        recommendedById: admin.id,
        status: "pending",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/refunds/${refund.id}/reject`,
      headers: {
        cookie: await loginAs(app, admin.phone),
        "x-requested-with": "XMLHttpRequest",
      },
      payload: { reason: "Not eligible" },
    });

    expect(res.statusCode).toBe(200);
    const updated = await prisma.refundRequest.findUnique({ where: { id: refund.id } });
    expect(updated?.status).toBe("rejected");
  });

  it("refuses a non-super admin from rejecting a refund", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("RFD4");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348095000051",
      pin: "1234",
    });
    const member = await createTestMember(coop.id, { phone: "2348095000052" });
    const refund = await prisma.refundRequest.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        amount: 5000,
        reason: "Duplicate",
        recommendedById: admin.id,
        status: "pending",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/admin/refunds/${refund.id}/reject`,
      headers: {
        cookie: await loginAs(app, admin.phone),
        "x-requested-with": "XMLHttpRequest",
      },
      payload: { reason: "No" },
    });

    expect(res.statusCode).toBe(403);
    const unchanged = await prisma.refundRequest.findUnique({ where: { id: refund.id } });
    expect(unchanged?.status).toBe("pending");
  });
});
