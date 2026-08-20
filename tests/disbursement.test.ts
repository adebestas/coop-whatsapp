import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { approveLoan } from "../src/services/loans.js";
import { namesMatch } from "../src/services/disbursements.js";

// Mock the payment provider so we control account-name resolution + payouts.
vi.mock("../src/lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
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

/** Run the full loan flow up to approval. Returns the borrower's loan. */
async function getGuaranteedLoan(borrowerName?: string) {
  const coop = await makeCoop("TEST21");
  const borrower = await makeMember(PHONE, coop.id, { name: borrowerName });
  await makeMember(G1, coop.id);
  await makeMember(G2, coop.id);
  await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });

  await handleMessage(PHONE, "loan 50000 2");
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
  return loan!;
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.resolveName = "ADA OBI";
  state.resolveFails = false;
  state.payoutFails = false;
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
    const loan = await getGuaranteedLoan("Ada Obi");

    const result = await approveLoan(loan.id.slice(-6));
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
    const texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(texts).toContain("disbursed");
  });

  it("blocks disbursement when the account name does not match the registered name", async () => {
    const loan = await getGuaranteedLoan("Chinedu Eze"); // registered under a different name
    state.resolveName = "SADE BALOGUN"; // account belongs to someone else

    const result = await approveLoan(loan.id.slice(-6));
    expect(result.ok).toBe(true); // approved, but NOT paid out

    const updated = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(updated!.status).toBe("approved"); // not disbursed
    expect(updated!.disbursementStatus).toBe("name_mismatch");
    expect(updated!.disbursementError).toContain("SADE BALOGUN");

    const payout = await prisma.payout.findFirst({ where: { memberId: loan.memberId } });
    expect(payout).toBeNull(); // no money moved
  });

  it("marks a failed disbursement without paying when the provider can't resolve", async () => {
    const loan = await getGuaranteedLoan();
    state.resolveFails = true;

    await approveLoan(loan.id.slice(-6));

    const updated = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(updated!.status).toBe("approved");
    expect(updated!.disbursementStatus).toBe("failed");
    expect(await prisma.payout.count()).toBe(0);
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
  it("withdraws up to 45% of savings to the member's bank after PIN confirmation", async () => {
    const coop = await makeCoop("TEST22");
    const member = await makeMember(PHONE, coop.id, { name: "Ada Obi" });
    await prisma.wallet.update({ where: { memberId: member.id }, data: { balance: 10000 } });

    await handleMessage(PHONE, "withdraw 4000");
    await handleMessage(PHONE, "0123456789"); // account
    await handleMessage(PHONE, "Access"); // bank
    await handleMessage(PHONE, "1234"); // PIN

    const updated = await prisma.member.findUnique({
      where: { id: member.id },
      include: { wallet: true },
    });
    expect(updated!.wallet!.balance).toBe(6000);
    expect(updated!.bankAccountNumber).toBe("0123456789");
    expect(updated!.bankCode).toBe("044");

    const payout = await prisma.payout.findFirst({ where: { memberId: member.id } });
    expect(payout).not.toBeNull();
    expect(payout!.amount).toBe(4000);
    expect(payout!.status).toBe("successful");

    const texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(texts).toContain("Withdrew");
  });

  it("rejects a withdrawal above the 45% cap without touching the wallet", async () => {
    const coop = await makeCoop("TEST23");
    const member = await makeMember(PHONE, coop.id, { name: "Ada Obi" });
    await prisma.wallet.update({ where: { memberId: member.id }, data: { balance: 10000 } });

    await handleMessage(PHONE, "withdraw 5000"); // max is 4500

    const updated = await prisma.member.findUnique({
      where: { id: member.id },
      include: { wallet: true },
    });
    expect(updated!.wallet!.balance).toBe(10000);
    expect(await prisma.payout.count()).toBe(0);

    const texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(texts).toContain("45%");
  });

  it("does not pay out when the withdrawal account name does not match", async () => {
    const coop = await makeCoop("TEST24");
    const member = await makeMember(PHONE, coop.id, { name: "Chinedu Eze" });
    await prisma.wallet.update({ where: { memberId: member.id }, data: { balance: 10000 } });
    state.resolveName = "SADE BALOGUN";

    await handleMessage(PHONE, "withdraw 4000");
    await handleMessage(PHONE, "0123456789");
    await handleMessage(PHONE, "Access");
    await handleMessage(PHONE, "1234");

    const updated = await prisma.member.findUnique({
      where: { id: member.id },
      include: { wallet: true },
    });
    expect(updated!.wallet!.balance).toBe(10000); // money never left
    expect(await prisma.payout.count()).toBe(0);
  });
});