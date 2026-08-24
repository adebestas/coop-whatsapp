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
import { createUnit, joinUnit, setUnitAdmin, broadcastToScope } from "../src/services/units.js";
import { computeDividendPreview, distributeDividend } from "../src/services/dividends.js";
import { recordLedger } from "../src/services/ledger.js";
import { runAutoSaveReminders, runMonthlyStatements, runBirthdayGreetings, setAutoSave, setInterestRate } from "../src/services/scheduler.js";
import { createContribution } from "../src/services/cooperative.js";

vi.mock("../src/lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
  notifyMember: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
  sendSecurePrompt: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
}));

const ADMIN_PHONE = "2348090000001";
const PHONE = "2348010000001";
const OTHER_PHONE = "2348010000002";

async function makeCoop(code: string, name: string, adminPhone?: string) {
  return prisma.cooperative.create({ data: { name, code, adminPhone } });
}

async function makeMember(phone: string, coopId: string, opts: { role?: string } = {}) {
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
      pin: hashPin("1234"),
      wallet: { create: {} },
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
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

describe("workplaces (units)", () => {
  it("creates a unit, members join it, unit admin broadcasts only to their unit", async () => {
    const coop = await makeCoop("TEST11", "Test Coop", ADMIN_PHONE);
    await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const a = await makeMember(PHONE, coop.id);
    const b = await makeMember(OTHER_PHONE, coop.id);

    const created = await createUnit(ADMIN_PHONE, "Lagos Office", "LAG01");
    expect(created.ok).toBe(true);

    await joinUnit(PHONE, "LAG01");
    await joinUnit(OTHER_PHONE, "LAG01");

    const unit = await prisma.unit.findFirst({ where: { code: "LAG01" } });
    expect(unit).not.toBeNull();
    expect(await prisma.member.count({ where: { unitId: unit!.id } })).toBe(2);

    await setUnitAdmin(ADMIN_PHONE, "LAG01", a.code);
    const updatedUnit = await prisma.unit.findUnique({ where: { id: unit!.id } });
    expect(updatedUnit!.adminMemberId).toBe(a.id);

    // Unit admin broadcasts -> only unit members receive it.
    await broadcastToScope({ senderPhone: PHONE, message: "Meeting Friday", scope: "unit" });
    const calls = vi.mocked(sendText).mock.calls.map((c) => c[0].to)
      .concat(vi.mocked(notifyMember).mock.calls.map((c) => String(c[0].phone ?? c[0])));
    expect(calls).toContain(PHONE);
    expect(calls).toContain(OTHER_PHONE);
    expect(calls).not.toContain(ADMIN_PHONE);

    // Coop admin broadcasts -> everyone in the coop receives it.
    vi.clearAllMocks();
    await broadcastToScope({ senderPhone: ADMIN_PHONE, message: "All hands", scope: "coop" });
    const all = vi.mocked(sendText).mock.calls.map((c) => c[0].to)
      .concat(vi.mocked(notifyMember).mock.calls.map((c) => String(c[0].phone ?? c[0])));
    expect(all).toContain(PHONE);
    expect(all).toContain(OTHER_PHONE);
    expect(all).toContain(ADMIN_PHONE);
  });
});

describe("ledger + statement", () => {
  it("shows the transparent ledger and personal history", async () => {
    const coop = await makeCoop("TEST12", "Test Coop");
    await makeMember(PHONE, coop.id);

    await createContribution(PHONE, 10000);
    await handleMessage(PHONE, "ledger");

    let texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(texts).toContain("Ledger");
    expect(texts).toContain("Total savings in");
    expect(texts).toContain("NGN 10,000.00");

    vi.clearAllMocks();
    await handleMessage(PHONE, "history");
    texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(texts).toContain("statement");
    expect(texts).toContain("Deposits");
    expect(texts).toContain("NGN 10,000.00");
  });
});

describe("recurring contributions + interest", () => {
  it("sets a weekly plan and fires reminders when due", async () => {
    const coop = await makeCoop("TEST13", "Test Coop");
    await makeMember(PHONE, coop.id);

    const plan = await setAutoSave(PHONE, 2000, "weekly");
    expect(plan.ok).toBe(true);

    // Backdate the next-due so a scheduler run nags the member.
    await prisma.member.updateMany({
      where: { phone: PHONE },
      data: { autoSaveNextDue: new Date(Date.now() - 1000) },
    });

    const sent = await runAutoSaveReminders();
    expect(sent).toBe(1);

    const texts = allTexts().join("\n");
    expect(texts).toContain("Time to save");
    expect(texts).toContain("NGN 2,000.00");

    const member = await prisma.member.findFirst({ where: { phone: PHONE } });
    expect(member!.autoSaveNextDue!.getTime()).toBeGreaterThan(Date.now());
  });

  it("turns the plan off", async () => {
    const coop = await makeCoop("TEST14", "Test Coop");
    await makeMember(PHONE, coop.id);
    await setAutoSave(PHONE, 2000, "weekly");
    await setAutoSave(PHONE, null);
    const member = await prisma.member.findFirst({ where: { phone: PHONE } });
    expect(member!.autoSaveEnabled).toBe(false);
  });

  it("sets the loan interest rate (interest is on loans, never savings)", async () => {
    const coop = await makeCoop("TEST15", "Test Coop");
    const member = await makeMember(PHONE, coop.id);
    await prisma.wallet.update({ where: { memberId: member.id }, data: { balance: 10000 } });

    await setInterestRate(ADMIN_PHONE, 1); // not an admin yet -> rejected
    await prisma.member.update({ where: { id: member.id }, data: { role: "admin" } });
    const set = await setInterestRate(PHONE, 1.5);
    expect(set.ok).toBe(true);

    const updated = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(updated!.loanInterestRate).toBe(1.5);

    // Savings balances are untouched — no interest accrues on savings.
    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet!.balance).toBe(10000);
  });
});

describe("dividends", () => {
  it("computes a real-time dividend preview from net profit and distributes to wallets", async () => {
    const coop = await makeCoop("TEST16", "Test Coop", ADMIN_PHONE);
    await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    await makeMember(PHONE, coop.id);
    await makeMember(OTHER_PHONE, coop.id);

    await createContribution(PHONE, 40000);
    await createContribution(OTHER_PHONE, 60000);

    // Profit comes from the books now: 120k income - 20k expenses = 100k.
    await recordLedger({ cooperativeId: coop.id, type: "income", category: "interest", amount: 120000, note: "loan interest" });
    await recordLedger({ cooperativeId: coop.id, type: "expense", category: "operating_cost", amount: 20000, note: "stationery + logistics" });
    const superAdmin = await makeMember("2348075555555", coop.id, { role: "superadmin" });

    const preview = await computeDividendPreview(PHONE, 5);
    expect(preview.ok).toBe(true);
    expect(preview.message).toContain("Dividend pool");
    expect(preview.message).toContain("NGN 100,000.00"); // net profit
    expect(preview.message).toContain("NGN 5,000.00"); // 5% of profit
    expect(preview.message).toContain("NGN 2,000.00"); // PHONE's share = 5% of 40,000

    const result = await distributeDividend(superAdmin.phone, 5);
    expect(result.ok).toBe(true);

    const phoneMember = await prisma.member.findFirst({ where: { phone: PHONE }, include: { wallet: true } });
    expect(phoneMember!.wallet!.balance).toBe(42000); // 40,000 saved + 2,000 dividend
    expect(phoneMember!.wallet!.totalSaved).toBe(40000); // dividend doesn't inflate savings base

    const entries = await prisma.dividendEntry.count();
    expect(entries).toBe(2); // both members got an entry (admin has no savings -> 0, skipped)

    const dividend = await prisma.dividend.findFirst();
    expect(dividend!.status).toBe("distributed");
  });
});

describe("monthly statements + birthday greetings", () => {
  it("sends each active member a statement on the 1st of the month", async () => {
    const coop = await makeCoop("TEST17", "Test Coop");
    await makeMember(PHONE, coop.id);
    await createContribution(PHONE, 10000);

    const sent = await runMonthlyStatements(new Date("2026-08-01"));
    expect(sent).toBe(1);

    const member = await prisma.member.findFirst({ where: { phone: PHONE } });
    expect(member!.lastStatementSentAt).not.toBeNull();

    const texts = allTexts().join("\n");
    expect(texts).toContain("statement");
    expect(texts).toContain("NGN 10,000.00");

    // Same month: no duplicate statement.
    vi.clearAllMocks();
    const again = await runMonthlyStatements(new Date("2026-08-15"));
    expect(again).toBe(0);
  });

  it("does nothing outside the 1st of the month", async () => {
    const coop = await makeCoop("TEST18", "Test Coop");
    await makeMember(PHONE, coop.id);

    const sent = await runMonthlyStatements(new Date("2026-08-15"));
    expect(sent).toBe(0);
  });

  it("greets a member on their birthday exactly once per year", async () => {
    const coop = await makeCoop("TEST19", "Test Coop");
    const member = await makeMember(PHONE, coop.id);
    await prisma.member.update({
      where: { id: member.id },
      data: { dateOfBirth: new Date(2000, 7, 15) }, // 15 August
    });

    const sent = await runBirthdayGreetings(new Date("2026-08-15"));
    expect(sent).toBe(1);

    const texts = allTexts().join("\n");
    expect(texts).toContain("Happy Birthday");

    const updated = await prisma.member.findUnique({ where: { id: member.id } });
    expect(updated!.lastBirthdayGreetedYear).toBe(2026);

    // Running again the same year must not double-greet.
    vi.clearAllMocks();
    const again = await runBirthdayGreetings(new Date("2026-08-15"));
    expect(again).toBe(0);
  });

  it("does not greet members whose birthday is not today", async () => {
    const coop = await makeCoop("TEST20", "Test Coop");
    const member = await makeMember(PHONE, coop.id);
    await prisma.member.update({
      where: { id: member.id },
      data: { dateOfBirth: new Date(2000, 0, 1) },
    });

    const sent = await runBirthdayGreetings(new Date("2026-08-15"));
    expect(sent).toBe(0);
  });
});


