import { beforeEach, describe, expect, it } from "vitest";
import { cleanupDatabase, createTestCoop, createTestMember, prisma } from "./setup.js";
import { recommendRefund, approveRefund, rejectRefund } from "../src/services/refunds.js";

/**
 * Maker-checker refunds: an admin recommends a refund, a super admin approves
 * (which pays the member's saved bank account via the shared payout path) or
 * rejects it. Uses the app-wide payments mock from tests/setup.ts.
 */
async function setup() {
  const coop = await createTestCoop("RFND01");
  const superadmin = await createTestMember(coop.id, {
    phone: "2348090000001",
    role: "superadmin",
    name: "Boss Super",
  });
  const admin = await createTestMember(coop.id, {
    phone: "2348090000002",
    role: "admin",
    name: "Ada Admin",
  });
  // Name matches the provider's resolved account name ("ADA OBI") so the shared
  // payout path's name check passes.
  const member = await createTestMember(coop.id, { phone: "2348090000003", name: "ADA OBI" });
  await prisma.member.update({
    where: { id: member.id },
    data: { bankAccountNumber: "0123456789", bankCode: "058", bankName: "GTBank" },
  });
  const recommendActor = { id: admin.id, phone: admin.phone, role: admin.role };
  const superActor = { id: superadmin.id, phone: superadmin.phone, role: superadmin.role };
  return { coop, superadmin, admin, member, recommendActor, superActor };
}

beforeEach(async () => {
  await cleanupDatabase();
});

describe("refund maker-checker", () => {
  it("recommendRefund creates a pending RefundRequest with the amount and reason", async () => {
    const { coop, member, recommendActor } = await setup();

    const res = await recommendRefund(
      coop.id,
      member.id,
      500000,
      "Double payment: bank transfer + direct debit",
      recommendActor,
    );

    expect(res.ok).toBe(true);
    expect(res.refundId).toBeTruthy();
    const row = await prisma.refundRequest.findUnique({ where: { id: res.refundId! } });
    expect(row).toMatchObject({
      status: "pending",
      amount: 500000,
      reason: "Double payment: bank transfer + direct debit",
      memberId: member.id,
      cooperativeId: coop.id,
      recommendedById: recommendActor.id,
    });
  });

  it("approveRefund by a super admin pays the member's bank and marks it paid", async () => {
    const { coop, member, recommendActor, superActor } = await setup();
    const rec = await recommendRefund(coop.id, member.id, 500000, "Double payment", recommendActor);

    const res = await approveRefund(coop.id, rec.refundId!, superActor);

    expect(res.ok).toBe(true);
    const row = await prisma.refundRequest.findUnique({ where: { id: rec.refundId! } });
    expect(row!.status).toBe("paid");
    expect(row!.approvedById).toBe(superActor.id);
    expect(row!.paidAt).toBeInstanceOf(Date);
    expect(row!.payoutRef).toBeTruthy();
    expect(await prisma.payout.count()).toBe(1);
  });

  it("approveRefund by a non-super-admin is refused", async () => {
    const { coop, member, recommendActor } = await setup();
    const rec = await recommendRefund(coop.id, member.id, 500000, "Double payment", recommendActor);

    const res = await approveRefund(coop.id, rec.refundId!, recommendActor);

    expect(res.ok).toBe(false);
    const row = await prisma.refundRequest.findUnique({ where: { id: rec.refundId! } });
    expect(row!.status).toBe("pending");
  });

  it("rejectRefund sets status rejected and records the reason", async () => {
    const { coop, member, recommendActor, superActor } = await setup();
    const rec = await recommendRefund(coop.id, member.id, 500000, "Double payment", recommendActor);

    const res = await rejectRefund(coop.id, rec.refundId!, "Not a double payment", superActor);

    expect(res.ok).toBe(true);
    const row = await prisma.refundRequest.findUnique({ where: { id: rec.refundId! } });
    expect(row!.status).toBe("rejected");
    expect(row!.reason).toContain("Not a double payment");
    expect(await prisma.payout.count()).toBe(0);
  });

  it("refuses to approve a refund for a member with no saved bank account", async () => {
    const { coop, recommendActor, superActor } = await setup();
    const noBank = await createTestMember(coop.id, { phone: "2348090000004", name: "No Bank" });
    const rec = await recommendRefund(coop.id, noBank.id, 100000, "Double payment", recommendActor);

    const res = await approveRefund(coop.id, rec.refundId!, superActor);

    expect(res.ok).toBe(false);
    const row = await prisma.refundRequest.findUnique({ where: { id: rec.refundId! } });
    expect(row!.status).toBe("pending");
    expect(await prisma.payout.count()).toBe(0);
  });
});
