import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText, notifyMember } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";

vi.mock("../src/lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
  sendSecurePrompt: vi.fn().mockResolvedValue(true),
  notifyMember: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
}));

const ADMIN_PHONE = "2348011111111";
const SUPER_PHONE = "2348022222222";
const M1 = "2348033333333";
const M2 = "2348044444444";
const M3 = "2348055555555";

async function makeCoop(code: string, name: string, adminPhone?: string) {
  return prisma.cooperative.create({ data: { name, code, adminPhone } });
}

async function makeMember(phone: string, coopId: string, opts: { role?: string } = {}) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  const m = await prisma.member.create({
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
  return m;
}

function texts() {
  return [
    ...vi.mocked(sendText).mock.calls.map((c) => c[0].text),
    ...vi.mocked(notifyMember).mock.calls.map((c) => String(c[1])),
  ].join("\n");
}

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.coopPost.deleteMany();
  await prisma.deductionItem.deleteMany();
  await prisma.deductionWaiver.deleteMany();
  await prisma.deductionBatch.deleteMany();
  await prisma.posting.deleteMany();
  await prisma.journalEntry.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.beneficiary.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.contribution.deleteMany();
  await prisma.loanRepayment.deleteMany();
  await prisma.guarantor.deleteMany();
  await prisma.loan.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.member.deleteMany();
  await prisma.unit.deleteMany();
  await prisma.cooperative.deleteMany();
  await prisma.session.deleteMany();
});

describe("employer deduction remittance", () => {
  it("builds a batch with savings AND loan-repayment items, then approval credits both", async () => {
    // adminPhone makes SUPER a super-admin; separate plain admin also exists.
    const coop = await makeCoop("DEDB01", "Remit Coop", SUPER_PHONE);
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const saver = await makeMember(M1, coop.id);
    const payer = await makeMember(M2, coop.id);

    await handleMessage(ADMIN_PHONE, `setcommit ${saver.code} 5000`);
    await handleMessage(ADMIN_PHONE, `setcommit ${payer.code} 3000`);
    expect(texts()).toContain("monthly deduction");

    // Payer has an active loan: installment must ride the same remittance.
    await prisma.loan.create({
      data: {
        memberId: payer.id,
        cooperativeId: coop.id,
        amount: 20000,
        balance: 20000,
        monthlyPayment: 5000,
        status: "disbursed",
      },
    });

    await handleMessage(ADMIN_PHONE, "newbatch");
    expect(texts()).toContain("Loan repayments: 1");
    expect(texts()).toContain("NGN 13,000"); // 5000 + 3000 + 5000

    const batch = await prisma.deductionBatch.findFirst({ include: { items: true } });
    expect(batch!.items.length).toBe(3);
    expect(batch!.items.filter((i) => i.kind === "loan").length).toBe(1);

    await handleMessage(ADMIN_PHONE, `submitbatch ${batch!.ref}`);
    expect(texts()).toContain("submitted");

    const superTexts = vi.mocked(notifyMember).mock.calls.map((c) => String(c[1]));
    expect(superTexts.some((t) => t.includes("approvebatch"))).toBe(true);

    // Super approves -> money lands, everyone is told on their platform.
    vi.clearAllMocks();
    await handleMessage(SUPER_PHONE, `approvebatch ${batch!.ref}`);

    const saverWallet = await prisma.wallet.findUnique({ where: { memberId: saver.id } });
    expect(saverWallet!.balance).toBe(5000);
    expect(saverWallet!.totalSaved).toBe(5000);
    const saverContrib = await prisma.contribution.findFirst({ where: { memberId: saver.id } });
    expect(saverContrib?.status).toBe("confirmed");

    const loan = await prisma.loan.findFirst({ where: { memberId: payer.id } });
    expect(loan!.balance).toBe(15000);
    const repayments = await prisma.loanRepayment.findMany({ where: { loanId: loan!.id } });
    expect(repayments.reduce((s, r) => s + r.amount, 0)).toBe(5000);

    const payerWallet = await prisma.wallet.findUnique({ where: { memberId: payer.id } });
    expect(payerWallet!.balance).toBe(3000); // loan item did NOT touch wallet

    const notes = vi.mocked(notifyMember).mock.calls.map((c) => ({ to: c[0].phone, text: String(c[1]) }));
    expect(notes.find((n) => n.to === saver.phone)?.text).toContain("credited to your savings");
    expect(notes.find((n) => n.to === payer.phone)?.text).toContain("Remaining balance");

    const approved = await prisma.deductionBatch.findUnique({ where: { ref: batch!.ref } });
    expect(approved!.status).toBe("approved");
    const audited = await prisma.auditLog.findFirst({
      where: { cooperativeId: coop.id, action: "deduction.batch.approve" },
    });
    expect(audited).not.toBeNull();
  });

  it("waived members are skipped for that period and can ask for the waiver themselves", async () => {
    const coop = await makeCoop("DEDB02", "Waive Coop", SUPER_PHONE);
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const waver = await makeMember(M1, coop.id);
    const steady = await makeMember(M2, coop.id);
    await handleMessage(ADMIN_PHONE, `setcommit ${waver.code} 4000`);
    await handleMessage(ADMIN_PHONE, `setcommit ${steady.code} 2000`);

    // Member asks admins to skip this month.
    await handleMessage(M1, "skipmonth");
    expect(texts()).toContain("Request sent");

    // Admin confirms the waiver.
    vi.clearAllMocks();
    await handleMessage(ADMIN_PHONE, `waive ${waver.code}`);
    expect(await prisma.deductionWaiver.count({ where: { memberId: waver.id } })).toBe(1);
    expect(vi.mocked(notifyMember).mock.calls.map((c) => String(c[1])).join("\n")).toContain("waived your deduction");

    await handleMessage(ADMIN_PHONE, "newbatch");
    expect(texts()).not.toContain(waver.code);
    expect(texts()).toContain("NGN 2,000");

    // Member sees their waived status.
    await handleMessage(M1, "mydeduction");
    expect(texts()).toMatch(/Waived for \d{4}-\d{2}/);
    expect(await prisma.deductionWaiver.count({ where: { memberId: steady.id } })).toBe(0);
  });

  it("only supers approve or reject; rejection tells the submitting admin", async () => {
    const coop = await makeCoop("DEDB03", "Gate Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const m = await makeMember(M1, coop.id);
    await handleMessage(ADMIN_PHONE, `setcommit ${m.code} 1000`);
    await handleMessage(ADMIN_PHONE, "newbatch");
    const batch = await prisma.deductionBatch.findFirst();

    await handleMessage(ADMIN_PHONE, `approvebatch ${batch!.ref}`);
    expect(texts()).toContain("Only the *super admin*");
    expect((await prisma.deductionBatch.findUnique({ where: { ref: batch!.ref } }))!.status).toBe("draft");

    await handleMessage(ADMIN_PHONE, `submitbatch ${batch!.ref}`);
    vi.clearAllMocks();
    await handleMessage(SUPER_PHONE, `rejectbatch ${batch!.ref} cheque bounced`);
    expect((await prisma.deductionBatch.findUnique({ where: { ref: batch!.ref } }))!.status).toBe("rejected");
    expect(
      vi.mocked(sendText).mock.calls.map((c) => c[0].text).some((t) => t.includes("rejected") && t.includes("cheque bounced")),
    ).toBe(true);

    // A rejected batch cannot be approved afterwards.
    await handleMessage(SUPER_PHONE, `approvebatch ${batch!.ref}`);
    expect(texts()).toContain("rejected, not submitted");
  });

  it("full repayment via remittance closes the loan", async () => {
    const coop = await makeCoop("DEDB04", "Close Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const payer = await makeMember(M1, coop.id);
    await handleMessage(ADMIN_PHONE, `setcommit ${payer.code} 0`); // no savings item
    const loan = await prisma.loan.create({
      data: { memberId: payer.id, cooperativeId: coop.id, amount: 8000, balance: 8000, status: "disbursed" }, // no monthlyPayment -> full balance due
    });

    await handleMessage(ADMIN_PHONE, "newbatch");
    await handleMessage(ADMIN_PHONE, `submitbatch ${(await prisma.deductionBatch.findFirst())!.ref}`);
    vi.clearAllMocks();
    await handleMessage(SUPER_PHONE, `approvebatch ${(await prisma.deductionBatch.findFirst())!.ref}`);

    const done = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(done!.balance).toBe(0);
    expect(done!.status).toBe("paid");
    expect(texts()).toContain("fully repaid");
  });
});

describe("lost phone / WhatsApp recovery", () => {
  it("super relinks an account to a new number, wiping stale sessions", async () => {
    const coop = await makeCoop("RECO01", "Recover Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const victim = await makeMember(M1, coop.id);
    await prisma.session.create({ data: { phone: M1, state: "awaiting_pin", data: "{}" } });

    await handleMessage(SUPER_PHONE, `relink ${victim.code} ${M2}`);

    const moved = await prisma.member.findUnique({ where: { id: victim.id } });
    expect(moved!.phone).toBe(M2);
    expect(await prisma.session.count({ where: { phone: M1 } })).toBe(0);
    const audited = await prisma.auditLog.findFirst({ where: { action: "account.relink" } });
    expect(audited).not.toBeNull();
    // Old number was warned.
    expect(
      vi.mocked(sendText).mock.calls.map((c) => c[0].to).includes(M1),
    ).toBe(true);
    // The old number can no longer act as the member.
    await handleMessage(M1, "balance");
    expect(texts().toLowerCase()).toContain("join a cooperative first");
  });

  it("unlink detaches a dead second channel", async () => {
    const coop = await makeCoop("RECO02", "Unlink Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const m = await makeMember(M1, coop.id);
    await prisma.member.update({
      where: { id: m.id },
      data: { altChannelId: "tg:999", preferredChannel: "telegram" },
    });

    await handleMessage(SUPER_PHONE, `unlink ${m.code}`);
    const fresh = await prisma.member.findUnique({ where: { id: m.id } });
    expect(fresh!.altChannelId).toBeNull();
    expect(fresh!.preferredChannel).toBeNull();
  });

  it("plain members cannot relink accounts", async () => {
    const coop = await makeCoop("RECO03", "Nope Coop");
    const pleb = await makeMember(M1, coop.id, { role: "member" });
    const other = await makeMember(M2, coop.id);

    await handleMessage(M1, `relink ${other.code} ${M3}`);
    const still = await prisma.member.findUnique({ where: { id: other.id } });
    expect(still!.phone).toBe(M2);
  });
});
