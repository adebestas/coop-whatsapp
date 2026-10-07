/**
 * Task 12: account-name confirmation on all Monnify payouts.
 *
 * Before every payout/transfer, the recipient's account name is resolved via
 * the provider's `resolveAccount` and confirmed against the expected recipient.
 * If the name cannot be resolved, the payout is HELD (fail-closed). This is
 * exercised through the shared `confirmAccountName` helper used by the common
 * `sendToBank` payout path (withdrawals, refunds, dividends) and by the
 * pay-anyone path (`approveExternalPayment`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupDatabase, prisma } from "./setup.js";
import { paymentState } from "./payment-state.js";
import { confirmAccountName, sendToBank } from "../src/services/disbursements.js";
import { requestExternalPayment, approveExternalPayment } from "../src/services/payanyone.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { notifyMember } from "../src/lib/messaging.js";

const ADMIN_PHONE = "2348090000001";
const PHONE = "2348010000001";

function allTexts(): string {
  return vi
    .mocked(notifyMember)
    .mock.calls.map((c) => String(c[1]))
    .join("\n");
}

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: "Test Coop", code, adminPhone: null } });
}

async function makeMember(
  phone: string,
  coopId: string,
  opts: { role?: string; name?: string } = {},
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  return prisma.member.create({
    data: {
      code,
      phone,
      name: opts.name ?? `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role: opts.role ?? "member",
      status: "active",
      pin: hashPin("1234"),
      wallet: { create: {} },
    },
  });
}

beforeEach(async () => {
  await cleanupDatabase();
  vi.clearAllMocks();
  paymentState.resolveName = "ADA OBI";
  paymentState.resolveFails = false;
  paymentState.payoutFails = false;
  paymentState.payoutPending = false;
});

describe("confirmAccountName (shared payout confirmation)", () => {
  it("confirms when the resolved name matches the expected recipient", async () => {
    const provider = {
      name: "monnify",
      resolveAccount: vi.fn(async () => ({ ok: true, name: "ADA OBI" })),
    };
    const result = await confirmAccountName({
      provider: provider as any,
      accountNumber: "0123456789",
      bankCode: "058",
      expectedName: "Ada Obi",
    });
    expect(provider.resolveAccount).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("confirmed");
    expect(result.name).toBe("ADA OBI");
  });

  it("holds on a name mismatch with the expected recipient", async () => {
    const result = await confirmAccountName({
      provider: { name: "monnify", resolveAccount: async () => ({ ok: true, name: "SADE BALOGUN" }) } as any,
      accountNumber: "0123456789",
      bankCode: "058",
      expectedName: "Ada Obi",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("name_mismatch");
    expect(result.name).toBe("SADE BALOGUN");
  });

  it("holds (fail-closed) when the account cannot be resolved", async () => {
    const result = await confirmAccountName({
      provider: {
        name: "monnify",
        resolveAccount: async () => ({ ok: false, error: "account not found" }),
      } as any,
      accountNumber: "0123456789",
      bankCode: "058",
      expectedName: "Ada Obi",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("unresolved");
    expect(result.error).toContain("account not found");
  });

  it("holds (fail-closed) when the provider has no resolver", async () => {
    const result = await confirmAccountName({
      provider: { name: "legacy" } as any,
      accountNumber: "0123456789",
      bankCode: "058",
      expectedName: "Ada Obi",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("unresolved");
  });

  it("uses the provider's own resolve path (Paystack)", async () => {
    const resolveAccount = vi.fn(async () => ({ ok: true, name: "VIC VENTURES" }));
    const result = await confirmAccountName({
      provider: { name: "paystack", resolveAccount } as any,
      accountNumber: "0123456789",
      bankCode: "058",
      expectedName: "Vic Ventures",
    });
    expect(resolveAccount).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("confirmed");
  });

  it("skips the comparison when explicitly requested (death-claim payouts)", async () => {
    const result = await confirmAccountName({
      provider: {
        name: "monnify",
        resolveAccount: async () => ({ ok: true, name: "SADE BALOGUN" }),
      } as any,
      accountNumber: "0123456789",
      bankCode: "058",
      expectedName: "Ada Obi",
      skip: true,
    });
    expect(result.ok).toBe(true);
    expect(result.name).toBe("SADE BALOGUN");
  });
});

describe("sendToBank confirmation (withdrawal/refund/dividend shared path)", () => {
  it("holds the payout and alerts on a name mismatch", async () => {
    const coop = await makeCoop("PNC1");
    const member = await makeMember(PHONE, coop.id, { name: "Ada Obi" });
    paymentState.resolveName = "SADE BALOGUN";

    const result = await sendToBank({
      memberId: member.id,
      amount: 500_000,
      bankAccountNumber: "0123456789",
      bankCode: "058",
      note: "Member withdrawal (test)",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("name_mismatch");
    expect(await prisma.payout.count()).toBe(0);
    expect(allTexts()).toMatch(/does not match/i);
  });

  it("holds the payout (fail-closed) when the account cannot be resolved", async () => {
    const coop = await makeCoop("PNC2");
    const member = await makeMember(PHONE, coop.id, { name: "Ada Obi" });
    paymentState.resolveFails = true;

    const result = await sendToBank({
      memberId: member.id,
      amount: 500_000,
      bankAccountNumber: "0123456789",
      bankCode: "058",
      note: "Refund (test)",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(await prisma.payout.count()).toBe(0);
  });

  it("pays when the resolved name matches, carrying a description", async () => {
    const coop = await makeCoop("PNC3");
    const member = await makeMember(PHONE, coop.id, { name: "Ada Obi" });
    paymentState.resolveName = "ADA OBI";

    const result = await sendToBank({
      memberId: member.id,
      amount: 500_000,
      bankAccountNumber: "0123456789",
      bankCode: "058",
      note: "Dividend payout to Ada Obi",
    });

    expect(result.ok).toBe(true);
    const payout = await prisma.payout.findFirst({ where: { memberId: member.id } });
    expect(payout).not.toBeNull();
    expect(payout!.note).toContain("Dividend");
  });
});

describe("pay-anyone confirmation", () => {
  async function setupPayment(beneficiaryName: string) {
    const coop = await makeCoop("PNC9");
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const s1 = await makeMember("2348071111111", coop.id, { role: "superadmin" });
    const s2 = await makeMember("2348072222222", coop.id, { role: "superadmin" });
    const s3 = await makeMember("2348073333333", coop.id, { role: "superadmin" });
    const req = await requestExternalPayment(admin, {
      beneficiaryName,
      accountNumber: "0123456789",
      bankCode: "058",
      amount: 25_000,
      purpose: "Generator repair",
    });
    expect(req.ok).toBe(true);
    const payment = await prisma.externalPayment.findUnique({ where: { id: req.paymentId! } });
    return { coop, admin, s1, s2, s3, payment: payment! };
  }

  it("holds and alerts when the account name does not match the beneficiary", async () => {
    const { s1, s2, s3, payment } = await setupPayment("Vic Ventures");
    paymentState.resolveName = "SADE BALOGUN";

    await approveExternalPayment(s1, payment.id.slice(-6));
    await approveExternalPayment(s2, payment.id.slice(-6));
    const final = await approveExternalPayment(s3, payment.id.slice(-6));

    expect(final.ok).toBe(false);
    const after = await prisma.externalPayment.findUnique({ where: { id: payment.id } });
    expect(after!.status).not.toBe("paid");
    expect(await prisma.payout.count()).toBe(0);
    expect(allTexts()).toMatch(/does not match/i);
  });

  it("holds (fail-closed) when the account cannot be resolved", async () => {
    const { s1, s2, s3, payment } = await setupPayment("Vic Ventures");
    paymentState.resolveFails = true;

    await approveExternalPayment(s1, payment.id.slice(-6));
    await approveExternalPayment(s2, payment.id.slice(-6));
    const final = await approveExternalPayment(s3, payment.id.slice(-6));

    expect(final.ok).toBe(false);
    expect(await prisma.payout.count()).toBe(0);
  });

  it("pays when the account name matches the beneficiary", async () => {
    const { admin, s1, s2, s3, payment } = await setupPayment("Vic Ventures");
    paymentState.resolveName = "VIC VENTURES";

    await approveExternalPayment(s1, payment.id.slice(-6));
    await approveExternalPayment(s2, payment.id.slice(-6));
    const final = await approveExternalPayment(s3, payment.id.slice(-6));

    expect(final.ok).toBe(true);
    const after = await prisma.externalPayment.findUnique({ where: { id: payment.id } });
    expect(after!.status).toBe("paid");
    const payout = await prisma.payout.findFirst({ where: { memberId: admin.id } });
    expect(payout).not.toBeNull();
    expect(payout!.note).toContain("confirmed");
  });
});
