import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupDatabase, createTestCoop, createTestMember, prisma } from "./setup.js";
import { recommendRefund, approveRefund, rejectRefund, approveRefundAsOmbudsman } from "../src/services/refunds.js";
import { resolveProvider } from "../src/services/payments/index.js";

/**
 * Capture the provider `payout` call so tests can assert the transfer targets
 * the member's SAVED bank account (the key correctness property). tests/setup.ts
 * owns the payments mock, so we override `resolveProvider` for this file.
 */
const payoutSpy = vi.fn();

beforeEach(() => {
  payoutSpy.mockReset();
  payoutSpy.mockResolvedValue({ ok: true, providerRef: "trx-1" });
  vi.mocked(resolveProvider).mockImplementation(
    () =>
      ({
        name: "monnify",
        createVirtualAccount: vi.fn(async () => ({ accountNumber: "1234567890" })),
        payout: payoutSpy,
        resolveAccount: vi.fn(async () => ({ ok: true, name: "ADA OBI" })),
        getTransferStatus: vi.fn(async () => ({ status: "successful" })),
        verifyWebhook: () => true,
        parseNotification: () => null,
      }) as unknown as ReturnType<typeof resolveProvider>,
  );
});

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
    // The transfer must target the member's SAVED bank account.
    expect(payoutSpy).toHaveBeenCalledTimes(1);
    expect(payoutSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 500000,
        bankAccountNumber: "0123456789",
        bankCode: "058",
      }),
    );
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

  it("rejects a refund reason over 200 characters", async () => {
    const { coop, member, recommendActor } = await setup();

    const res = await recommendRefund(
      coop.id,
      member.id,
      50000,
      "x".repeat(201),
      recommendActor,
    );

    expect(res.ok).toBe(false);
    expect(await prisma.refundRequest.count()).toBe(0);
  });

  it("re-approves a refund the provider explicitly declined (safe to retry)", async () => {
    const { coop, member, recommendActor, superActor } = await setup();
    const rec = await recommendRefund(coop.id, member.id, 500000, "Double payment", recommendActor);
    // An explicit decline means NO money moved and no Payout row exists, so the
    // deterministic TFR-REFUND key makes a retry safe.
    await prisma.refundRequest.update({
      where: { id: rec.refundId! },
      data: {
        status: "failed",
        payoutRef: "Not paid out: provider error (declined). No money moved.",
      },
    });

    const res = await approveRefund(coop.id, rec.refundId!, superActor);

    expect(res.ok).toBe(true);
    const row = await prisma.refundRequest.findUnique({ where: { id: rec.refundId! } });
    expect(row!.status).toBe("paid");
    expect(row!.paidAt).toBeInstanceOf(Date);
    expect(payoutSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses to re-approve a refund whose payout outcome is unconfirmed", async () => {
    const { coop, member, recommendActor, superActor } = await setup();
    const rec = await recommendRefund(coop.id, member.id, 500000, "Double payment", recommendActor);
    // The provider may have accepted the transfer already; retrying could
    // double-pay. This must stay blocked until a human reconciles.
    await prisma.refundRequest.update({
      where: { id: rec.refundId! },
      data: { status: "failed", payoutRef: "unsure: awaiting provider authorization" },
    });

    const res = await approveRefund(coop.id, rec.refundId!, superActor);

    expect(res.ok).toBe(false);
    const row = await prisma.refundRequest.findUnique({ where: { id: rec.refundId! } });
    expect(row!.status).toBe("failed");
    expect(payoutSpy).not.toHaveBeenCalled();
  });

  it("approveRefundAsOmbudsman lets an active ombudsman approve directly", async () => {
    const { coop, member, recommendActor } = await setup();
    const ombudsman = await prisma.ombudsman.create({
      data: { name: "Ada Ombuds", phone: "2348000099999", active: true },
    });
    const rec = await recommendRefund(coop.id, member.id, 500000, "Double payment", recommendActor);

    const res = await approveRefundAsOmbudsman(coop.id, rec.refundId!, {
      id: ombudsman.id,
      phone: ombudsman.phone,
    });

    expect(res.ok).toBe(true);
    const row = await prisma.refundRequest.findUnique({ where: { id: rec.refundId! } });
    expect(row!.status).toBe("paid");
    expect(row!.approvedById).toBe(ombudsman.id);
    expect(payoutSpy).toHaveBeenCalledTimes(1);
  });

  it("approveRefundAsOmbudsman refuses a caller who is not an active ombudsman", async () => {
    const { coop, member, recommendActor } = await setup();
    // An inactive ombudsman phone must not authorize a payout.
    await prisma.ombudsman.create({
      data: { name: "Retired", phone: "2348000088888", active: false },
    });
    const rec = await recommendRefund(coop.id, member.id, 500000, "Double payment", recommendActor);

    const res = await approveRefundAsOmbudsman(coop.id, rec.refundId!, {
      id: "someone",
      phone: "2348000088888",
    });

    expect(res.ok).toBe(false);
    const row = await prisma.refundRequest.findUnique({ where: { id: rec.refundId! } });
    expect(row!.status).toBe("pending");
    expect(payoutSpy).not.toHaveBeenCalled();
  });
});
