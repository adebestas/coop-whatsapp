import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";
import { handlePaymentNotification } from "../src/services/payments/topup.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";

vi.mock("../src/lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
}));

const PHONE = "2348012345678";
const ADMIN_PHONE = "2348099999999";
const G1_PHONE = "2348071111111";
const G2_PHONE = "2348072222222";

async function makeCoop(code: string, name: string, adminPhone?: string) {
  return prisma.cooperative.create({
    data: { name, code, adminPhone },
  });
}

async function makeMember(
  phone: string,
  coopId: string,
  opts: { role?: string; pin?: string; vaNumber?: string } = {},
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role: opts.role ?? "member",
      pin: opts.pin ? hashPin(opts.pin) : hashPin("1234"),
      ...(opts.vaNumber ? { virtualAccountNumber: opts.vaNumber } : {}),
      wallet: { create: {} },
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.contribution.deleteMany();
  await prisma.loanRepayment.deleteMany();
  await prisma.guarantor.deleteMany();
  await prisma.loan.deleteMany();
  await prisma.payout.deleteMany();
  await prisma.dividendEntry.deleteMany();
  await prisma.dividend.deleteMany();
  await prisma.broadcast.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.member.deleteMany();
  await prisma.unit.deleteMany();
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
    expect(member!.code).toMatch(/^[A-Z2-9]{6}-[A-Z2-9]{4}$/);

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

  it("serves Telegram users through the same flow, tagged with tg: ids", async () => {
    const coop = await makeCoop("TEST05", "Test Coop");
    const TG = "tg:123456789";

    await handleMessage(TG, "join TEST05");
    await handleMessage(TG, "Bola Musa");
    await handleMessage(TG, "08012345678");
    await handleMessage(TG, "5555");
    await handleMessage(TG, "5555");

    const member = await prisma.member.findUnique({
      where: { cooperativeId_phone: { cooperativeId: coop.id, phone: TG } },
      include: { wallet: true },
    });
    expect(member).not.toBeNull();
    expect(member!.code).toMatch(/^[A-Z2-9]{6}-[A-Z2-9]{4}$/);
    expect(member!.contactPhone).toBe("2348012345678");

    // Replies are addressed to the tg: id, not a phone.
    const calls = vi.mocked(sendText).mock.calls;
    expect(calls.some((c) => c[0].to === TG)).toBe(true);
    expect(calls.every((c) => c[0].to.startsWith("tg:"))).toBe(true);
  });
it("requires 2 confirmed guarantors before a loan can be approved", async () => {
    const coop = await makeCoop("TEST04", "Test Coop", ADMIN_PHONE);
    const borrower = await makeMember(PHONE, coop.id, { pin: "1234" });
    await makeMember(G1_PHONE, coop.id, { pin: "1111" });
    await makeMember(G2_PHONE, coop.id, { pin: "2222" });
    await makeMember(ADMIN_PHONE, coop.id, { role: "admin", pin: "9999" });

    // Apply for a loan — bot should ask for guarantor 1.
    await handleMessage(PHONE, "loan 50000 2");

    let loan = await prisma.loan.findFirst({ where: { memberId: borrower.id } });
    expect(loan).not.toBeNull();
    expect(loan!.status).toBe("pending");

    // Admin tries to approve before guarantors -> must be rejected.
    const shortId = loan!.id.slice(-6);
    await handleMessage(ADMIN_PHONE, `approve ${shortId}`);
    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("pending");

    // Add guarantor 1 by member code.
    const g1 = await prisma.member.findFirst({ where: { phone: G1_PHONE } });
    const g2 = await prisma.member.findFirst({ where: { phone: G2_PHONE } });
    await handleMessage(PHONE, g1!.code);
    await handleMessage(PHONE, g2!.code);

    const guarantors = await prisma.guarantor.findMany({
      where: { loanId: loan!.id },
      include: { member: true },
    });
    expect(guarantors).toHaveLength(2);
    expect(guarantors.map((g) => g.status)).toEqual(["pending", "pending"]);
    expect(new Set(guarantors.map((g) => g.code)).size).toBe(2); // unique codes

    // Admin still can't approve — guarantors haven't confirmed.
    await handleMessage(ADMIN_PHONE, `approve ${shortId}`);
    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("pending");

    // Guarantors confirm with their codes.
    for (const g of guarantors) {
      await handleMessage(g.member.phone, `confirm ${g.code}`);
    }

    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("guaranteed");

    // Now the admin can approve.
    await handleMessage(ADMIN_PHONE, `approve ${shortId}`);
    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("approved");
    expect(loan!.monthlyPayment).toBeGreaterThan(0);

    // Fund the wallet then repay.
    await prisma.wallet.updateMany({ data: { balance: { increment: 100000 } } });
    await handleMessage(PHONE, "repay");
    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.balance).toBeLessThan(50000 * 1.04);
  });
});