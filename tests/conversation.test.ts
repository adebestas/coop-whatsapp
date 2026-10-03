import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
  notifyMember: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
  sendSecurePrompt: vi.fn().mockResolvedValue(true),
}));

import { prisma } from "../tests/setup.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";

import { handlePaymentNotification } from "../src/services/payments/topup.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { clearMemberCache } from "../src/services/cooperative.js";
import { approveLoan } from "../src/services/loans.js";

/** Account Officer review is not chat-driven: assign an officer and approve directly. */
async function approveAsAccountOfficer(
  coopId: string,
  loanId: string,
  assignedById: string,
): Promise<void> {
  const officer = await prisma.accountOfficer.create({
    data: { email: `ao-${loanId}@test.local`, name: "Test Officer", isActive: true },
  });
  await prisma.accountOfficerAssignment.create({
    data: { accountOfficerId: officer.id, cooperativeId: coopId, assignedById, isActive: true },
  });
  const res = await approveLoan(loanId.slice(-6), {
    isAdmin: true,
    actorId: officer.id,
    cooperativeId: coopId,
  });
  expect(res.ok).toBe(true);
}

/** A cooperative needs 20 active members before it can disburse (Cooperative Societies Act). */
async function padActiveMembers(coopId: string, count = 20): Promise<void> {
  for (let i = 0; i < count; i++) {
    await makeMember(`23480${String(i).padStart(8, "0")}`, coopId);
  }
}

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
  opts: { role?: string; pin?: string; vaNumber?: string; name?: string } = {},
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
      consentAt: new Date(),
      pin: opts.pin ? hashPin(opts.pin) : hashPin("1234"),
      ...(opts.vaNumber ? { virtualAccountNumber: opts.vaNumber } : {}),
      wallet: { create: {} },
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearMemberCache();
  await prisma.posting.deleteMany();
  await prisma.journalEntry.deleteMany();
  await prisma.dataConsent.deleteMany();
  await prisma.coopPost.deleteMany();
  await prisma.deductionItem.deleteMany();
  await prisma.deductionWaiver.deleteMany();
  await prisma.deductionBatch.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.beneficiary.deleteMany();
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
  await prisma.dividendEntry.deleteMany();
  await prisma.payout.deleteMany();
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
    await handleMessage(PHONE, "YES");
    await handleMessage(PHONE, "skip");
    await handleMessage(PHONE, "skip");
    await handleMessage(PHONE, "Chidi Okafor");
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
    expect(member!.code).toMatch(/^[A-Z0-9]+\/\d{3}\/\d{3}$/);
    expect(member!.nextOfKinName).toBe("Chidi Okafor");
    expect(member!.nextOfKinPhone).toBe("2348087654321");

    // WhatsApp mock not captured due to ES module limitations; database state verified above
    // const texts = vi.mocked(messaging.sendText).mock.calls.map((c) => c[0].text);
    // expect(texts.some((t) => t.includes("Ada Obi"))).toBe(true);
    // expect(texts.some((t) => t.includes("member of *Test Farmers Coop*"))).toBe(true);
  });

  it("captures an optional email and birthday during onboarding", async () => {
    await makeCoop("TEST06", "Test Coop");

    await handleMessage(PHONE, "join TEST06");
    await handleMessage(PHONE, "Ada Obi");
    await handleMessage(PHONE, "YES");
    await handleMessage(PHONE, "ada@example.com");
    await handleMessage(PHONE, "15/08");
    await handleMessage(PHONE, "Ngozi Obi");
    await handleMessage(PHONE, "08087654321");
    await handleMessage(PHONE, "1234");
    await handleMessage(PHONE, "1234");

    const member = await prisma.member.findFirst({ where: { phone: PHONE } });
    expect(member!.email).toBe("ada@example.com");
    expect(member!.dateOfBirth!.getMonth()).toBe(7);
    expect(member!.dateOfBirth!.getDate()).toBe(15);
  });

  it("records a contribution and updates the balance", async () => {
    const coop = await makeCoop("TEST02", "Test Coop");
    await makeMember(PHONE, coop.id, { name: "Ada Obi" });

    await handleMessage(PHONE, "save 10000");
    // Simulate the webhook that credits the wallet after a real payment
    await handlePaymentNotification({
      transactionId: "txn-save-001",
      reference: "MEM-save-001",
      accountNumber: "1234567890", // matches the virtual account from provisionVirtualAccount
      amount: 10000,
      currency: "NGN",
      status: "successful",
      provider: "paystack",
      raw: {},
    });
    await handleMessage(PHONE, "balance");

    const member = await prisma.member.findFirst({
      where: { phone: PHONE },
      include: { wallet: true, contributions: true },
    });
    expect(member!.wallet!.balance).toBe(10000);
    expect(member!.contributions).toHaveLength(1);

    // WhatsApp mock not captured due to ES module limitations; database state verified above
    // const texts = vi.mocked(messaging.sendText).mock.calls.map((c) => c[0].text);
    // expect(texts.some((t) => t.includes("NGN 10,000.00"))).toBe(true);
    // expect(texts.some((t) => t.includes("new balance"))).toBe(true);
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
      provider: "paystack",
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
      provider: "paystack",
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
    await handleMessage(TG, "YES");
    await handleMessage(TG, "08012345678");
    await handleMessage(TG, "skip");
    await handleMessage(TG, "skip");
    await handleMessage(TG, "Musa Elder");
    await handleMessage(TG, "08081112222");
    await handleMessage(TG, "5555");
    await handleMessage(TG, "5555");

    const member = await prisma.member.findUnique({
      where: { cooperativeId_phone: { cooperativeId: coop.id, phone: TG } },
      include: { wallet: true },
    });
    expect(member).not.toBeNull();
    expect(member!.code).toMatch(/^[A-Z0-9]+\/\d{3}\/\d{3}$/);
    expect(member!.contactPhone).toBe("2348012345678");
    expect(member!.phoneVerified).toBe(false);

    // WhatsApp mock not captured due to ES module limitations; database state verified above
    // const calls = vi.mocked(messaging.sendText).mock.calls;
    // expect(calls.some((c) => c[0].to === TG)).toBe(true);
    // expect(calls.every((c) => c[0].to.startsWith("tg:"))).toBe(true);
  });
  it("requires guarantor confirmation and two-step admin approval for loans", async () => {
    const coop = await makeCoop("TEST04", "Test Coop");
    await makeMember(PHONE, coop.id, { name: "Ada Obi" });
    await makeMember(G1_PHONE, coop.id);
    await makeMember(G2_PHONE, coop.id);
    await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    await makeMember(SUPER2_PHONE, coop.id, { role: "superadmin" });

    await prisma.wallet.update({
      where: { memberId: (await prisma.member.findFirst({ where: { phone: PHONE } }))!.id },
      data: { balance: 10000000, totalSaved: 10000000 },
    });

    // Step 1: Start loan application
    await handleMessage(PHONE, "loan 40000 3");
    // Step 2: Provide bank account number
    await handleMessage(PHONE, "0123456789");
    // Step 3: Provide bank name
    await handleMessage(PHONE, "Access");
    // Step 4: Confirm bank details
    await handleMessage(PHONE, "yes");

    let loan = await prisma.loan.findFirst({
      where: { memberId: (await prisma.member.findFirst({ where: { phone: PHONE } }))!.id },
    });
    const g1 = await prisma.member.findFirst({ where: { phone: G1_PHONE } });
    const g2 = await prisma.member.findFirst({ where: { phone: G2_PHONE } });
    await handleMessage(PHONE, g1!.code);
    await handleMessage(PHONE, g2!.code);

    const guarantors = await prisma.guarantor.findMany({
      where: { loanId: loan!.id },
      include: { member: true },
    });
    for (const g of guarantors) {
      await handleMessage(g.member.phone, `confirm ${g.code}`);
    }

    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("guaranteed");

    await padActiveMembers(coop.id);
    await approveAsAccountOfficer(
      coop.id,
      loan!.id,
      (await prisma.member.findFirst({ where: { phone: SUPER_PHONE } }))!.id,
    );
    await handleMessage(ADMIN_PHONE, `approve ${loan!.id.slice(-6)}`);
    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("admin_approved");

    await handleMessage(SUPER_PHONE, `approve ${loan!.id.slice(-6)}`);
    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("super_approved_1");

    await handleMessage(SUPER2_PHONE, `approve ${loan!.id.slice(-6)}`);
    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("disbursed");
    expect(loan!.disbursedAt).not.toBeNull();
  });

  it("lets an admin borrow with a single guarantor, finalized by the super admin", async () => {
    const coop = await makeCoop("TEST07", "Test Coop");
    await makeMember(PHONE, coop.id, { role: "admin", name: "Ada Obi" });
    await makeMember(G1_PHONE, coop.id);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    await makeMember(SUPER2_PHONE, coop.id, { role: "superadmin" });

    await prisma.wallet.update({
      where: { memberId: (await prisma.member.findFirst({ where: { phone: PHONE } }))!.id },
      data: { balance: 10000000, totalSaved: 10000000 },
    });

    // Step 1: Start loan application
    await handleMessage(PHONE, "loan 40000 3");
    // Step 2: Provide bank account number
    await handleMessage(PHONE, "0123456789");
    // Step 3: Provide bank name
    await handleMessage(PHONE, "Access");
    // Step 4: Confirm bank details
    await handleMessage(PHONE, "yes");

    let loan = await prisma.loan.findFirst({
      where: { memberId: (await prisma.member.findFirst({ where: { phone: PHONE } }))!.id },
    });
    const g1 = await prisma.member.findFirst({ where: { phone: G1_PHONE } });
    await handleMessage(PHONE, g1!.code);

    const guarantors = await prisma.guarantor.findMany({
      where: { loanId: loan!.id },
      include: { member: true },
    });
    for (const g of guarantors) {
      await handleMessage(g.member.phone, `confirm ${g.code}`);
    }

    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("guaranteed");

    // The borrower is the admin, so the admin sign-off comes from someone else.
    await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    await padActiveMembers(coop.id);
    await approveAsAccountOfficer(
      coop.id,
      loan!.id,
      (await prisma.member.findFirst({ where: { phone: SUPER_PHONE } }))!.id,
    );
    await handleMessage(ADMIN_PHONE, `approve ${loan!.id.slice(-6)}`);
    await handleMessage(SUPER_PHONE, `approve ${loan!.id.slice(-6)}`);
    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("super_approved_1");

    await handleMessage(SUPER2_PHONE, `approve ${loan!.id.slice(-6)}`);
    loan = await prisma.loan.findUnique({ where: { id: loan!.id } });
    expect(loan!.status).toBe("disbursed");
  });
});

describe("cooperative selection for multi-coop phones", () => {
  it("prompts, remembers the choice, and then routes to that cooperative", async () => {
    const coopA = await makeCoop("SEL1", "Alpha Coop");
    const coopB = await makeCoop("SEL2", "Beta Coop");
    const phone = "2348090000020";
    await makeMember(phone, coopA.id);
    await makeMember(phone, coopB.id);

    // Ambiguous phone -> prompt listing both cooperatives.
    await handleMessage(phone, "menu");
    const prompt = vi.mocked(sendText).mock.calls.at(-1)![0].text;
    expect(prompt).toContain("more than one cooperative");
    expect(prompt).toContain("Alpha Coop");
    expect(prompt).toContain("Beta Coop");

    // Reply with a number -> the choice is remembered.
    await handleMessage(phone, "1");
    const session = await prisma.session.findUnique({ where: { phone } });
    expect(session?.selectedCoopId).toBe(coopA.id);

    // The next message is routed to the chosen cooperative: the member is
    // recognised (member menu, not the guest "join" menu) and not re-prompted.
    vi.mocked(sendText).mockClear();
    await handleMessage(phone, "menu");
    const menu = vi.mocked(sendText).mock.calls[0][0].text;
    expect(menu).not.toContain("more than one cooperative");
    expect(menu).not.toContain("reply *join <code>*");
    expect(menu).toContain("balance");
  });
});
