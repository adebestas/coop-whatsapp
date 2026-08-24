import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText, notifyMember } from "../src/lib/messaging.js";

/** Union of chat texts from both channels-aware senders. */
function allTexts(): string[] {
  return [
    ...vi.mocked(sendText).mock.calls.map((c) => c[0].text),
    ...vi.mocked(notifyMember).mock.calls.map((c) => String(c[1])),
  ];
}
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { approveLoan } from "../src/services/loans.js";
import { namesMatch } from "../src/services/disbursements.js";
import { resetMoneyRateLimit } from "../src/services/fraud.js";

// Mock the payment provider so we control account-name resolution + payouts.
vi.mock("../src/lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
  notifyMember: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
  sendSecurePrompt: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
}));

const state = {
  resolveName: "ADA OBI",
  resolveFails: false,
  payoutFails: false,
};

vi.mock("../src/services/payments/index.js", () => ({
  resolveProvider: () => ({
    name: "flutterwave",
    createVirtualAccount: vi.fn(),
    payout: vi.fn(async () =>
      state.payoutFails ? { ok: false, error: "insufficient balance" } : { ok: true, providerRef: "trx-1" },
    ),
    resolveAccount: vi.fn(async () =>
      state.resolveFails
        ? { ok: false, error: "account not found" }
        : { ok: true, name: state.resolveName },
    ),
    verifyWebhook: () => true,
    parseNotification: () => null,
  }),
}));

const ADMIN_PHONE = "2348090000001";
const PHONE = "2348010000001";
const G1 = "2348010000002";
const G2 = "2348010000003";

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: "Test Coop", code, adminPhone: ADMIN_PHONE } });
}

async function makeMember(phone: string, coopId: string, opts: { role?: string; name?: string } = {}) {
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
      pin: hashPin("1234"),
      wallet: { create: {} },
    },
  });
}

/** Run the full loan flow up to approval. Returns the loan + two super admin ids. */
async function getGuaranteedLoan(borrowerName?: string) {
  const coop = await makeCoop("TEST21");
  const borrower = await makeMember(PHONE, coop.id, { name: borrowerName });
  await makeMember(G1, coop.id);
  await makeMember(G2, coop.id);
  await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
  const super1 = await makeMember("2348070000001", coop.id, { role: "superadmin" });
  const super2 = await makeMember("2348070000002", coop.id, { role: "superadmin" });

  // Loans are capped at 2x savings — give the borrower history first.
  await prisma.wallet.update({
    where: { memberId: borrower.id },
    data: { balance: 200000, totalSaved: 200000 },
  });

  await handleMessage(PHONE, "loan 200000 2");
  await handleMessage(PHONE, "0123456789");
  await handleMessage(PHONE, "Access");

  let loan = await prisma.loan.findFirst({ where: { memberId: borrower.id } });
  const g1 = await prisma.member.findFirst({ where: { phone: G1 } });
  const g2 = await prisma.member.findFirst({ where: { phone: G2 } });
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
  return { loan: loan!, super1Id: super1.id, super2Id: super2.id };
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetMoneyRateLimit();
  state.resolveName = "ADA OBI";
  state.resolveFails = false;
  state.payoutFails = false;
    await prisma.posting.deleteMany();
  await prisma.journalEntry.deleteMany();
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

describe("loan disbursement", () => {
  it("disburses to the member's bank account when the name matches", async () => {
    const { loan, super1Id, super2Id } = await getGuaranteedLoan("Ada Obi");

    // Two distinct super admins must approve; the second auto-disburses.
    const one = await approveLoan(loan.id.slice(-6), { superAdmin: true, actorId: super1Id });
    expect(one.ok).toBe(true);
    const result = await approveLoan(loan.id.slice(-6), { superAdmin: true, actorId: super2Id });
    expect(result.ok).toBe(true);

    const updated = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(updated!.status).toBe("disbursed");
    expect(updated!.disbursementStatus).toBe("successful");
    expect(updated!.disbursedAt).not.toBeNull();

    const payout = await prisma.payout.findFirst({ where: { memberId: loan.memberId } });
    expect(payout).not.toBeNull();
    expect(payout!.status).toBe("successful");
    expect(payout!.providerRef).toBe("trx-1");

    // The member was notified.
    const texts = allTexts().join("\n");
    expect(texts).toContain("disbursed");
  });

  it("blocks disbursement when the account name does not match the registered name", async () => {
    const { loan, super1Id, super2Id } = await getGuaranteedLoan("Chinedu Eze"); // registered under a different name
    state.resolveName = "SADE BALOGUN"; // account belongs to someone else

    await approveLoan(loan.id.slice(-6), { superAdmin: true, actorId: super1Id });
    const result = await approveLoan(loan.id.slice(-6), { superAdmin: true, actorId: super2Id });
    expect(result.ok).toBe(true); // approved, but NOT paid out

    const updated = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(updated!.status).toBe("approved"); // not disbursed
    expect(updated!.disbursementStatus).toBe("name_mismatch");
    expect(updated!.disbursementError).toContain("SADE BALOGUN");

    const payout = await prisma.payout.findFirst({ where: { memberId: loan.memberId } });
    expect(payout).toBeNull(); // no money moved
  });

  it("marks a failed disbursement without paying when the provider can't resolve", async () => {
    const { loan, super1Id, super2Id } = await getGuaranteedLoan();
    state.resolveFails = true;

    await approveLoan(loan.id.slice(-6), { superAdmin: true, actorId: super1Id });
    await approveLoan(loan.id.slice(-6), { superAdmin: true, actorId: super2Id });

    const updated = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(updated!.status).toBe("approved");
    expect(updated!.disbursementStatus).toBe("failed");
    expect(await prisma.payout.count()).toBe(0);
  });

  it("requires the super admin's approval before an admin-approved loan pays out", async () => {
    const { loan, super1Id, super2Id } = await getGuaranteedLoan("Ada Obi");

    // Plain admin approval stops at admin_approved — no money moves.
    const first = await approveLoan(loan.id.slice(-6));
    expect(first.ok).toBe(true);
    let updated = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(updated!.status).toBe("admin_approved");
    expect(await prisma.payout.count()).toBe(0);

    // Two distinct super admins must sign off; the second releases the money.
    const second = await approveLoan(loan.id.slice(-6), { superAdmin: true, actorId: super1Id });
    expect(second.ok).toBe(true);
    updated = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(updated!.status).toBe("super_approved_1");
    expect(updated!.finalApprovedById).not.toBeNull();
    expect(await prisma.payout.count()).toBe(0);

    const third = await approveLoan(loan.id.slice(-6), { superAdmin: true, actorId: super2Id });
    expect(third.ok).toBe(true);
    updated = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(updated!.status).toBe("disbursed");
  });
});

describe("namesMatch", () => {
  it("is case/punctuation-insensitive and ignores extra title words", () => {
    expect(namesMatch("ADA OBI", "Ada Obi")).toBe(true);
    expect(namesMatch("OBI CHUKWU ADA", "Ada Obi")).toBe(true);
    expect(namesMatch("CHIEF ADA OBI", "Ada Obi")).toBe(true);
    expect(namesMatch("SADE BALOGUN", "Ada Obi")).toBe(false);
  });
});

describe("withdrawals", () => {
  it("creates a request, then pays out after admin approval + super admin finalization", async () => {
    const coop = await makeCoop("TEST22");
    const member = await makeMember(PHONE, coop.id, { name: "Ada Obi" });
    await makeMember(ADMIN_PHONE, coop.id, { role: "admin" }); // the coop's super admin
    await prisma.wallet.update({ where: { memberId: member.id }, data: { balance: 100000 } });

    await handleMessage(PHONE, "withdraw 40000");
    await handleMessage(PHONE, "0123456789"); // account
    await handleMessage(PHONE, "Access"); // bank
    await handleMessage(PHONE, "1234"); // PIN

    // The request exists but no money has moved yet.
    const req = await prisma.withdrawalRequest.findFirst({ where: { memberId: member.id } });
    expect(req).not.toBeNull();
    expect(req!.status).toBe("pending");
    let updated = await prisma.member.findUnique({
      where: { id: member.id },
      include: { wallet: true },
    });
    expect(updated!.wallet!.balance).toBe(100000);
    expect(updated!.bankAccountNumber).toBe("0123456789");
    expect(updated!.bankCode).toBe("044");

    // ADMIN_PHONE is the coop's registered super admin: one approval pays.
    await handleMessage(ADMIN_PHONE, `approvewdraw ${req!.id.slice(-6)}`);

    updated = await prisma.member.findUnique({
      where: { id: member.id },
      include: { wallet: true },
    });
    expect(updated!.wallet!.balance).toBe(60000);
    expect(updated!.lastWithdrawalAt).not.toBeNull();

    const paid = await prisma.withdrawalRequest.findUnique({ where: { id: req!.id } });
    expect(paid!.status).toBe("paid");
    expect(paid!.finalizedById).not.toBeNull();

    const payout = await prisma.payout.findFirst({ where: { memberId: member.id } });
    expect(payout).not.toBeNull();
    expect(payout!.amount).toBe(40000);
    expect(payout!.status).toBe("successful");

    const texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(texts).toContain("sent to");
  });

  it("stops at admin_approved until the super admin finalizes", async () => {
    const coop = await makeCoop("TEST25");
    const member = await makeMember(PHONE, coop.id, { name: "Ada Obi" });
    const plainAdmin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" }); // not the coop adminPhone
    await prisma.cooperative.update({ where: { id: coop.id }, data: { adminPhone: null } });
    await prisma.wallet.update({ where: { memberId: member.id }, data: { balance: 100000 } });

    await handleMessage(PHONE, "withdraw 40000");
    await handleMessage(PHONE, "0123456789");
    await handleMessage(PHONE, "Access");
    await handleMessage(PHONE, "1234");

    const req = await prisma.withdrawalRequest.findFirst({ where: { memberId: member.id } });

    // Plain admin approves -> waiting on super admin.
    await handleMessage(ADMIN_PHONE, `approvewdraw ${req!.id.slice(-6)}`);
    let after = await prisma.withdrawalRequest.findUnique({ where: { id: req!.id } });
    expect(after!.status).toBe("admin_approved");
    expect(after!.adminApprovedById).not.toBeNull();
    expect((await prisma.payout.count())).toBe(0);

    // Plain admin can't finalize.
    await handleMessage(ADMIN_PHONE, `finalize ${req!.id.slice(-6)}`);
    after = await prisma.withdrawalRequest.findUnique({ where: { id: req!.id } });
    expect(after!.status).toBe("admin_approved");

    // Super admin finalizes -> money moves.
    const superPhone = "2348090000099";
    await makeMember(superPhone, coop.id, { role: "superadmin" });
    await handleMessage(superPhone, `finalize ${req!.id.slice(-6)}`);

    after = await prisma.withdrawalRequest.findUnique({ where: { id: req!.id } });
    expect(after!.status).toBe("paid");
    const updated = await prisma.member.findUnique({ where: { id: member.id }, include: { wallet: true } });
    expect(updated!.wallet!.balance).toBe(60000);
    void plainAdmin;
  });

  it("enforces the 6-month rule and lets an admin override it", async () => {
    const coop = await makeCoop("TEST26");
    const member = await makeMember(PHONE, coop.id, { name: "Ada Obi" });
    await makeMember(ADMIN_PHONE, coop.id, { role: "admin" }); // the coop's super admin
    await prisma.wallet.update({ where: { memberId: member.id }, data: { balance: 100000 } });
    await prisma.member.update({
      where: { id: member.id },
      data: { lastWithdrawalAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }, // 1 month ago
    });

    await handleMessage(PHONE, "withdraw 40000");
    let texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(texts).toContain("once every 6 months");
    expect(await prisma.withdrawalRequest.count()).toBe(0);

    // Admin grants an override; the withdrawal goes through.
    await handleMessage(ADMIN_PHONE, `overridewithdrawal ${PHONE}`);
    vi.mocked(sendText).mock.calls.length = 0;

    await handleMessage(PHONE, "withdraw 40000");
    await handleMessage(PHONE, "0123456789");
    await handleMessage(PHONE, "Access");
    await handleMessage(PHONE, "1234");

    const req = await prisma.withdrawalRequest.findFirst({ where: { memberId: member.id } });
    expect(req).not.toBeNull();
    expect(req!.status).toBe("pending");
    texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(texts).toContain("requested");
  });

  it("rejects a withdrawal above the 45% cap without touching the wallet", async () => {
    const coop = await makeCoop("TEST23");
    const member = await makeMember(PHONE, coop.id, { name: "Ada Obi" });
    await prisma.wallet.update({ where: { memberId: member.id }, data: { balance: 100000 } });

    await handleMessage(PHONE, "withdraw 60000"); // max is 45000

    const updated = await prisma.member.findUnique({
      where: { id: member.id },
      include: { wallet: true },
    });
    expect(updated!.wallet!.balance).toBe(100000);
    expect(await prisma.payout.count()).toBe(0);
    expect(await prisma.withdrawalRequest.count()).toBe(0);

    const texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(texts).toContain("45%");
  });

  it("does not pay a withdrawal when the account name does not match", async () => {
    const coop = await makeCoop("TEST24");
    const member = await makeMember(PHONE, coop.id, { name: "Chinedu Eze" });
    await prisma.wallet.update({ where: { memberId: member.id }, data: { balance: 100000 } });
    state.resolveName = "SADE BALOGUN";

    await handleMessage(PHONE, "withdraw 40000");
    await handleMessage(PHONE, "0123456789");
    await handleMessage(PHONE, "Access");
    await handleMessage(PHONE, "1234");

    const req = await prisma.withdrawalRequest.findFirst({ where: { memberId: member.id } });
    expect(req).not.toBeNull();

    // Super admin approves and finalizes — but the name check blocks payout.
    await handleMessage(ADMIN_PHONE, `approvewdraw ${req!.id.slice(-6)}`);

    const updated = await prisma.member.findUnique({
      where: { id: member.id },
      include: { wallet: true },
    });
    expect(updated!.wallet!.balance).toBe(100000); // money never left
    expect(await prisma.payout.count()).toBe(0);

    const after = await prisma.withdrawalRequest.findUnique({ where: { id: req!.id } });
    expect(after!.status).not.toBe("paid");
  });
});


