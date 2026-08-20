import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/whatsapp.js";
import { handlePaymentNotification } from "../src/services/payments/topup.js";

vi.mock("../src/lib/whatsapp.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
}));

const PHONE = "2348012345678";
const ADMIN_PHONE = "2348099999999";

async function makeCoop(code: string, name: string, adminPhone?: string) {
  return prisma.cooperative.create({
    data: { name, code, adminPhone },
  });
}

async function makeMember(phone: string, coopId: string, opts: { role?: string; pin?: string; vaNumber?: string } = {}) {
  return prisma.member.create({
    data: {
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role: opts.role ?? "member",
      pin: opts.pin ?? "1234",
      ...(opts.vaNumber ? { virtualAccountNumber: opts.vaNumber } : {}),
      wallet: { create: {} },
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.loanRepayment.deleteMany();
  await prisma.loan.deleteMany();
  await prisma.payout.deleteMany();
  await prisma.contribution.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.member.deleteMany();
  await prisma.cooperative.deleteMany();
  await prisma.session.deleteMany();
});

describe("coop whatsapp bot", () => {
  it("registers a cooperative and joins a member via chat flow", async () => {
    await makeCoop("TEST01", "Test Farmers Coop");

    await handleMessage(PHONE, "join TEST01");
    await handleMessage(PHONE, "Ada Obi");
    await handleMessage(PHONE, "1234");
    await handleMessage(PHONE, "1234");

    const coop = await prisma.cooperative.findUnique({ where: { code: "TEST01" } });
    const member = await prisma.member.findUnique({
      where: { cooperativeId_phone: { cooperativeId: coop!.id, phone: PHONE } },
      include: { wallet: true },
    });
    expect(member).not.toBeNull();
    expect(member!.wallet!.balance).toBe(0);

    const texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text);
    expect(texts.some((t) => t.includes("Ada Obi"))).toBe(true);
    expect(texts.some((t) => t.includes("member of *Test Farmers Coop*"))).toBe(true);
  });

  it("records a contribution and updates the balance", async () => {
    const coop = await makeCoop("TEST02", "Test Coop");
    await makeMember(PHONE, coop.id);

    await handleMessage(PHONE, "save 5000");
    await handleMessage(PHONE, "balance");

    const member = await prisma.member.findFirst({
      where: { phone: PHONE },
      include: { wallet: true, contributions: true },
    });
    expect(member!.wallet!.balance).toBe(5000);
    expect(member!.contributions).toHaveLength(1);

    const texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text);
    expect(texts.some((t) => t.includes("NGN 5,000.00"))).toBe(true);
    expect(texts.some((t) => t.includes("new balance"))).toBe(true);
  });

  it("credits wallet when a payment webhook arrives for a member's virtual account", async () => {
    const coop = await makeCoop("TEST03", "Test Coop");
    await makeMember(PHONE, coop.id, { vaNumber: "1234567890" });

    await handlePaymentNotification({
      transactionId: "txn-001",
      reference: "MEM-xyz",
      accountNumber: "1234567890",
      amount: 10000,
      currency: "NGN",
      status: "successful",
      provider: "flutterwave",
      raw: {},
    });

    const member = await prisma.member.findFirst({
      where: { phone: PHONE },
      include: { wallet: true, contributions: true },
    });
    expect(member!.wallet!.balance).toBe(10000);
    expect(member!.contributions).toHaveLength(1);

    // Idempotent: replaying the same transaction must not double-credit.
    await handlePaymentNotification({
      transactionId: "txn-001",
      reference: "MEM-xyz",
      accountNumber: "1234567890",
      amount: 10000,
      currency: "NGN",
      status: "successful",
      provider: "flutterwave",
      raw: {},
    });
    const after = await prisma.member.findFirst({
      where: { phone: PHONE },
      include: { wallet: true },
    });
    expect(after!.wallet!.balance).toBe(10000);
  });

  it("applies for a loan, admin approves it, and the member repays", async () => {
    const coop = await makeCoop("TEST04", "Test Coop", ADMIN_PHONE);
    await makeMember(PHONE, coop.id);
    await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });

    await handleMessage(PHONE, "loan 50000 2");

    let loan = await prisma.loan.findFirst({ where: { status: "pending" } });
    expect(loan).not.toBeNull();
    expect(loan!.amount).toBe(50000);

    const loanIdShort = loan!.id.slice(-6);
    await handleMessage(ADMIN_PHONE, `approve ${loanIdShort}`);

    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("approved");
    expect(loan!.monthlyPayment).toBeGreaterThan(0);

    // Fund the member wallet then repay.
    await prisma.wallet.updateMany({ data: { balance: { increment: 100000 } } });
    await handleMessage(PHONE, "repay");

    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("approved"); // still paying, balance reduced
    expect(loan!.balance).toBeLessThan(50000 * 1.04);
  });
});