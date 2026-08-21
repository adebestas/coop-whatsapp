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
const SUPER_PHONE = "2348073333333";
const SUPER2_PHONE = "2348073444444";

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
    await prisma.posting.deleteMany();
  await prisma.journalEntry.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.pollBallot.deleteMany();
  await prisma.pollOption.deleteMany();
  await prisma.purchasePoll.deleteMany();
  await prisma.externalPayment.deleteMany();
  await prisma.guarantorDeduction.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.voteBallot.deleteMany();
  await prisma.voteCandidate.deleteMany();
  await prisma.vote.deleteMany();
  await prisma.supportTicket.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.deathValidation.deleteMany();
  await prisma.deathClaim.deleteMany();
  await prisma.withdrawalRequest.deleteMany();
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
    await handleMessage(PHONE, "skip"); // email is optional
    await handleMessage(PHONE, "skip"); // birthday is optional
    await handleMessage(PHONE, "Chidi Okafor"); // next of kin
    await handleMessage(PHONE, "08087654321");
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
    expect(member!.nextOfKinName).toBe("Chidi Okafor");
    expect(member!.nextOfKinPhone).toBe("2348087654321");

    const texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text);
    expect(texts.some((t) => t.includes("Ada Obi"))).toBe(true);
    expect(texts.some((t) => t.includes("member of *Test Farmers Coop*"))).toBe(true);
  });

  it("captures an optional email and birthday during onboarding", async () => {
    await makeCoop("TEST06", "Test Coop");

    await handleMessage(PHONE, "join TEST06");
    await handleMessage(PHONE, "Ada Obi");
    await handleMessage(PHONE, "ada@example.com");
    await handleMessage(PHONE, "15/08");
    await handleMessage(PHONE, "Ngozi Obi");
    await handleMessage(PHONE, "08087654321");
    await handleMessage(PHONE, "1234");
    await handleMessage(PHONE, "1234");

    const member = await prisma.member.findFirst({ where: { phone: PHONE } });
    expect(member!.email).toBe("ada@example.com");
    expect(member!.dateOfBirth!.getMonth()).toBe(7); // August
    expect(member!.dateOfBirth!.getDate()).toBe(15);
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
    await handleMessage(TG, "skip"); // email is optional
    await handleMessage(TG, "skip"); // birthday is optional
    await handleMessage(TG, "Musa Elder"); // next of kin
    await handleMessage(TG, "08081112222");
    await handleMessage(TG, "5555");
    await handleMessage(TG, "5555");

    const member = await prisma.member.findUnique({
      where: { cooperativeId_phone: { cooperativeId: coop.id, phone: TG } },
      include: { wallet: true },
    });
    expect(member).not.toBeNull();
    expect(member!.code).toMatch(/^[A-Z2-9]{6}-[A-Z2-9]{4}$/);
    expect(member!.contactPhone).toBe("2348012345678");
    expect(member!.phoneVerified).toBe(false); // no WhatsApp channel to deliver the OTP to

    // Replies are addressed to the tg: id, not a phone.
    const calls = vi.mocked(sendText).mock.calls;
    expect(calls.some((c) => c[0].to === TG)).toBe(true);
    expect(calls.every((c) => c[0].to.startsWith("tg:"))).toBe(true);
  });
it("requires guarantor confirmation and two-step admin approval for loans", async () => {
    const coop = await makeCoop("TEST04", "Test Coop"); // no adminPhone -> plain admins stay plain
    const borrower = await makeMember(PHONE, coop.id, { pin: "1234" });
    await makeMember(G1_PHONE, coop.id, { pin: "1111" });
    await makeMember(G2_PHONE, coop.id, { pin: "2222" });
    await makeMember(ADMIN_PHONE, coop.id, { role: "admin", pin: "9999" });
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin", pin: "8888" });
    await makeMember(SUPER2_PHONE, coop.id, { role: "superadmin", pin: "7777" });

    // Loans are capped at 2x savings — give the borrower some history first.
    await handleMessage(PHONE, "save 30000");

    // Apply for a loan — bot collects bank details, then asks for guarantor 1.
    await handleMessage(PHONE, "loan 50000 2");
    await handleMessage(PHONE, "0123456789"); // bank account
    await handleMessage(PHONE, "Access"); // bank name

    let loan = await prisma.loan.findFirst({ where: { memberId: borrower.id } });
    expect(loan).not.toBeNull();
    expect(loan!.status).toBe("pending");
    expect(loan!.bankAccountNumber).toBe("0123456789");
    expect(loan!.bankCode).toBe("044");

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

    // Step 1: plain admin approves -> waiting on the super admin.
    await handleMessage(ADMIN_PHONE, `approve ${shortId}`);
    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("admin_approved");

    // A second admin approval can't replace the super admin's sign-off.
    await handleMessage(ADMIN_PHONE, `approve ${shortId}`);
    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("admin_approved");

    // Step 2: first super admin signs off — one more to go (disbursement
    // fails gracefully in tests — no provider keys).
    await handleMessage(SUPER_PHONE, `approve ${shortId}`);
    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("super_approved_1");
    expect(loan!.finalApprovedById).not.toBeNull();

    // Step 3: a second distinct super admin finalizes.
    await handleMessage(SUPER2_PHONE, `approve ${shortId}`);
    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("approved");
    expect(loan!.monthlyPayment).toBeGreaterThan(0);

    // Fund the wallet then repay.
    await prisma.wallet.updateMany({ data: { balance: { increment: 100000 } } });
    await handleMessage(PHONE, "repay");
    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.balance).toBeLessThan(50000 * 1.04);
  });

  it("lets an admin borrow with a single guarantor, finalized by the super admin", async () => {
    const coop = await makeCoop("TEST07", "Test Coop");
    await makeMember(G1_PHONE, coop.id, { pin: "1111" });
    await makeMember(ADMIN_PHONE, coop.id, { role: "admin", pin: "9999" });
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin", pin: "8888" });
    await makeMember(SUPER2_PHONE, coop.id, { role: "superadmin", pin: "7777" });

    // Admins need savings too (2x cap) — and only 1 guarantor.
    await handleMessage(ADMIN_PHONE, "save 10000");
    await handleMessage(ADMIN_PHONE, "loan 20000 2");
    await handleMessage(ADMIN_PHONE, "0123456789");
    await handleMessage(ADMIN_PHONE, "Access");

    const loan = await prisma.loan.findFirst({ where: { member: { phone: ADMIN_PHONE } } });
    expect(loan).not.toBeNull();

    const g1 = await prisma.member.findFirst({ where: { phone: G1_PHONE } });
    await handleMessage(ADMIN_PHONE, g1!.code);
    const gs = await prisma.guarantor.findMany({ where: { loanId: loan!.id } });
    expect(gs).toHaveLength(1);
    await handleMessage(G1_PHONE, `confirm ${gs[0].code}`);

    const guaranteed = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(guaranteed!.status).toBe("guaranteed");

    const shortId = loan!.id.slice(-6);
    await handleMessage(ADMIN_PHONE, `approve ${shortId}`);
    await handleMessage(SUPER_PHONE, `approve ${shortId}`); // first super
    await handleMessage(SUPER2_PHONE, `approve ${shortId}`); // second super finalizes
    const done = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(done!.status).toBe("approved");
  });
});

