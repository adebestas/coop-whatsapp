import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanupDatabase } from "../tests/setup.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { scanGuarantorDefaults, executeDueDeductions } from "../src/services/guarantordeduction.js";
import { totalRepayable } from "../src/services/loans.js";
import { checkOtpRateLimit, resetRateLimit } from "../src/lib/cache.js";
import { paystackAdapter } from "../src/services/payments/paystack.js";
import { monnifyAdapter } from "../src/services/payments/monnify.js";

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: "Hardening Coop", code } });
}

async function makeMember(phone: string, coopId: string, opts: { role?: string } = {}) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role: opts.role ?? "member",
      pin: hashPin("1234"),
      wallet: { create: {} },
    },
    include: { wallet: true },
  });
}

beforeEach(async () => {
  await cleanupDatabase();
});

describe("guarantor deduction is capped at the remaining balance", () => {
  it("never deducts more than what is still owed on the loan", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
      const coop = await makeCoop("GDCAP");
      const borrower = await makeMember("2348011000001", coop.id);
      const g1 = await makeMember("2348011000002", coop.id);

      const loan = await prisma.loan.create({
        data: {
          memberId: borrower.id,
          cooperativeId: coop.id,
          amount: 20000,
          balance: 100, // tiny remaining balance vs the computed 50% interest share
          tenureMonths: 6,
          interestRate: 8,
          status: "disbursed",
          dueDate: new Date("2025-12-15T10:00:00Z"),
          guarantors: { create: [{ memberId: g1.id, status: "confirmed", code: "GT-CAP01" }] },
        },
        include: { guarantors: true },
      });

      const rawShare = Math.round((totalRepayable(20000, 6) - 20000) * 0.5 * 100) / 100;
      expect(rawShare).toBeGreaterThan(100); // the un-capped share is larger than the balance

      await scanGuarantorDefaults();
      const pending = await prisma.guarantorDeduction.findFirst();
      expect(pending).not.toBeNull();
      expect(pending!.amount).toBe(100); // capped to loan.balance

      await prisma.wallet.update({
        where: { memberId: g1.id },
        data: { balance: 5000, totalSaved: 5000 },
      });

      vi.setSystemTime(new Date("2026-03-12T10:00:00Z"));
      const res = await executeDueDeductions();
      expect(res.deducted).toBe(1);

      const after = await prisma.member.findUnique({
        where: { id: g1.id },
        include: { wallet: true },
      });
      expect(after!.wallet!.balance).toBe(4900); // 5000 - 100 (capped), never 5000 - rawShare
      void loan;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OTP request cooldown", () => {
  it("blocks an immediate re-request and recovers once the cooldown clears", async () => {
    const phone = "2348011000003";
    const first = await checkOtpRateLimit(phone);
    expect(first.allowed).toBe(true);

    const second = await checkOtpRateLimit(phone);
    expect(second.allowed).toBe(false);
    expect(second.message).toContain("wait");

    // Simulated cooldown expiry (the in-memory cooldown marker is cleared).
    await resetRateLimit(`otp_cooldown_mem:${phone}`);
    const third = await checkOtpRateLimit(phone);
    expect(third.allowed).toBe(true);
  });
});

describe("provider payload fail-closed", () => {
  it("Paystack rejects a charge.success with a malformed data shape", () => {
    expect(
      paystackAdapter.parseNotification({ event: "charge.success", data: { status: "success" } }),
    ).toBeNull();
    expect(paystackAdapter.parseNotification({ event: "charge.success" })).toBeNull();
    expect(paystackAdapter.parseNotification("garbage")).toBeNull();
  });

  it("Monnify rejects a successful transaction with a non-numeric amount", () => {
    expect(
      monnifyAdapter.parseNotification({
        eventType: "SUCCESSFUL_TRANSACTION",
        eventData: {
          amountPaid: "twelve",
          destinationAccountInformation: { accountNumber: "VA-1" },
        },
      }),
    ).toBeNull();
    expect(monnifyAdapter.parseNotification({ eventType: "SUCCESSFUL_TRANSACTION" })).toBeNull();
  });
});
