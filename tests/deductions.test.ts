import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanupDatabase } from "../tests/setup.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText, notifyMember } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { reconcileFromWebhook, reconcileFromStatement } from "../src/services/deductions.js";

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
      consentAt: new Date(),
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
  await cleanupDatabase();
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
    expect(texts()).toContain("₦130.00"); // 5000 + 3000 + 5000 kobo

    const batch = await prisma.deductionBatch.findFirst({ include: { items: true } });
    expect(batch!.items.length).toBe(3);
    expect(batch!.items.filter((i) => i.kind === "loan").length).toBe(1);

    await handleMessage(ADMIN_PHONE, `submitbatch ${batch!.ref}`);
    expect(texts()).toContain("submitted");

    const superTexts = vi.mocked(notifyMember).mock.calls.map((c) => String(c[1]));
    expect(superTexts.some((t) => t.includes("approvebatch"))).toBe(true);

    // Maker-checker: the maker's name must be confirmed by a super admin first.
    await handleMessage(SUPER_PHONE, `confirmname ${admin.code}`);

    // Money-in lifecycle: cheque received, then reconciled against the credit.
    await handleMessage(SUPER_PHONE, `recordcheque ${batch!.ref} 130`);
    await handleMessage(SUPER_PHONE, `reconbatch ${batch!.ref} 130`);

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

    const notes = vi
      .mocked(notifyMember)
      .mock.calls.map((c) => ({ to: c[0].phone, text: String(c[1]) }));
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
    expect(
      vi
        .mocked(notifyMember)
        .mock.calls.map((c) => String(c[1]))
        .join("\n"),
    ).toContain("waived your deduction");

    await handleMessage(ADMIN_PHONE, "newbatch");
    expect(texts()).not.toContain(waver.code);
    expect(texts()).toContain("₦20.00");

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
    expect((await prisma.deductionBatch.findUnique({ where: { ref: batch!.ref } }))!.status).toBe(
      "draft",
    );

    await handleMessage(ADMIN_PHONE, `submitbatch ${batch!.ref}`);
    vi.clearAllMocks();
    await handleMessage(SUPER_PHONE, `rejectbatch ${batch!.ref} cheque bounced`);
    expect((await prisma.deductionBatch.findUnique({ where: { ref: batch!.ref } }))!.status).toBe(
      "rejected",
    );
    expect(
      vi
        .mocked(sendText)
        .mock.calls.map((c) => c[0].text)
        .some((t) => t.includes("rejected") && t.includes("cheque bounced")),
    ).toBe(true);

    // A rejected batch cannot be approved afterwards.
    await handleMessage(SUPER_PHONE, `approvebatch ${batch!.ref}`);
    expect(texts()).toContain("rejected, not reconciled");
  });

  it("full repayment via remittance closes the loan", async () => {
    const coop = await makeCoop("DEDB04", "Close Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const payer = await makeMember(M1, coop.id);
    await handleMessage(ADMIN_PHONE, `setcommit ${payer.code} 0`); // no savings item
    const loan = await prisma.loan.create({
      data: {
        memberId: payer.id,
        cooperativeId: coop.id,
        amount: 8000,
        balance: 8000,
        status: "disbursed",
      }, // no monthlyPayment -> full balance due
    });

    await handleMessage(ADMIN_PHONE, "newbatch");
    await handleMessage(
      ADMIN_PHONE,
      `submitbatch ${(await prisma.deductionBatch.findFirst())!.ref}`,
    );
    await handleMessage(SUPER_PHONE, `confirmname ${admin.code}`);
    await handleMessage(SUPER_PHONE, `recordcheque ${(await prisma.deductionBatch.findFirst())!.ref} 80`);
    await handleMessage(SUPER_PHONE, `reconbatch ${(await prisma.deductionBatch.findFirst())!.ref} 80`);
    vi.clearAllMocks();
    await handleMessage(
      SUPER_PHONE,
      `approvebatch ${(await prisma.deductionBatch.findFirst())!.ref}`,
    );

    const done = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(done!.balance).toBe(0);
    expect(done!.status).toBe("paid");
    expect(texts()).toContain("fully repaid");
  });

  it("re-approving an approved batch does not double-credit", async () => {
    const coop = await makeCoop("DEDB05", "Idem Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const saver = await makeMember(M1, coop.id);
    await handleMessage(ADMIN_PHONE, `setcommit ${saver.code} 5000`);
    await handleMessage(ADMIN_PHONE, "newbatch");
    const batch = await prisma.deductionBatch.findFirst();
    await handleMessage(ADMIN_PHONE, `submitbatch ${batch!.ref}`);
    await handleMessage(SUPER_PHONE, `confirmname ${admin.code}`);
    await handleMessage(SUPER_PHONE, `recordcheque ${batch!.ref} 50`);
    await handleMessage(SUPER_PHONE, `reconbatch ${batch!.ref} 50`);
    await handleMessage(SUPER_PHONE, `approvebatch ${batch!.ref}`);

    const afterFirst = await prisma.wallet.findUnique({ where: { memberId: saver.id } });
    expect(afterFirst!.balance).toBe(5000);

    vi.clearAllMocks();
    await handleMessage(SUPER_PHONE, `approvebatch ${batch!.ref}`);
    expect(texts()).toContain("approved, not reconciled");

    const afterSecond = await prisma.wallet.findUnique({ where: { memberId: saver.id } });
    expect(afterSecond!.balance).toBe(5000);
    expect(await prisma.contribution.count({ where: { memberId: saver.id } })).toBe(1);
  });

  it("maker-checker: a super admin cannot approve their own batch", async () => {
    const coop = await makeCoop("DEDB06", "Self Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const m = await makeMember(M1, coop.id);
    await handleMessage(SUPER_PHONE, `setcommit ${m.code} 1000`);
    await handleMessage(SUPER_PHONE, "newbatch");
    const batch = await prisma.deductionBatch.findFirst();
    await handleMessage(SUPER_PHONE, `submitbatch ${batch!.ref}`);
    await handleMessage(SUPER_PHONE, `recordcheque ${batch!.ref} 10`);
    await handleMessage(SUPER_PHONE, `reconbatch ${batch!.ref} 10`);

    vi.clearAllMocks();
    await handleMessage(SUPER_PHONE, `approvebatch ${batch!.ref}`);
    expect(texts()).toContain("Maker-checker");
    expect((await prisma.deductionBatch.findUnique({ where: { ref: batch!.ref } }))!.status).toBe(
      "reconciled",
    );
    expect((await prisma.wallet.findUnique({ where: { memberId: m.id } }))!.balance).toBe(0);
  });

  it("maker-checker: an unverified maker's batch cannot be approved until confirmed", async () => {
    const coop = await makeCoop("DEDB07", "Unverified Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const m = await makeMember(M1, coop.id);
    await handleMessage(ADMIN_PHONE, `setcommit ${m.code} 1000`);
    await handleMessage(ADMIN_PHONE, "newbatch");
    const batch = await prisma.deductionBatch.findFirst();
    await handleMessage(ADMIN_PHONE, `submitbatch ${batch!.ref}`);
    await handleMessage(SUPER_PHONE, `recordcheque ${batch!.ref} 10`);
    await handleMessage(SUPER_PHONE, `reconbatch ${batch!.ref} 10`);

    vi.clearAllMocks();
    await handleMessage(SUPER_PHONE, `approvebatch ${batch!.ref}`);
    expect(texts()).toContain("name must be confirmed");
    expect((await prisma.deductionBatch.findUnique({ where: { ref: batch!.ref } }))!.status).toBe(
      "reconciled",
    );

    // After a super confirms the maker's name, approval succeeds.
    await handleMessage(SUPER_PHONE, `confirmname ${admin.code}`);
    await handleMessage(SUPER_PHONE, `approvebatch ${batch!.ref}`);
    expect((await prisma.deductionBatch.findUnique({ where: { ref: batch!.ref } }))!.status).toBe(
      "approved",
    );
  });

  it("a short reconciliation blocks approval until the full amount is received", async () => {
    const coop = await makeCoop("DEDB08", "Short Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const m = await makeMember(M1, coop.id);
    await handleMessage(ADMIN_PHONE, `setcommit ${m.code} 10000`);
    await handleMessage(ADMIN_PHONE, "newbatch");
    const batch = await prisma.deductionBatch.findFirst();
    await handleMessage(ADMIN_PHONE, `submitbatch ${batch!.ref}`);
    await handleMessage(SUPER_PHONE, `confirmname ${admin.code}`);
    await handleMessage(SUPER_PHONE, `recordcheque ${batch!.ref} 100`);
    await handleMessage(SUPER_PHONE, `reconbatch ${batch!.ref} 60`);

    vi.clearAllMocks();
    await handleMessage(SUPER_PHONE, `approvebatch ${batch!.ref}`);
    expect(texts()).toContain("reconciled short");
    expect((await prisma.wallet.findUnique({ where: { memberId: m.id } }))!.balance).toBe(0);

    // A later full reconciliation unblocks approval.
    await handleMessage(SUPER_PHONE, `reconbatch ${batch!.ref} 100`);
    await handleMessage(SUPER_PHONE, `approvebatch ${batch!.ref}`);
    expect((await prisma.wallet.findUnique({ where: { memberId: m.id } }))!.balance).toBe(10000);
  });

  it("auto-reconciles a cheque_received batch from a matching bank credit", async () => {
    const coop = await makeCoop("DEDB09", "Webhook Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const m = await makeMember(M1, coop.id);
    await handleMessage(ADMIN_PHONE, `setcommit ${m.code} 10000`);
    await handleMessage(ADMIN_PHONE, "newbatch");
    const batch = await prisma.deductionBatch.findFirst();
    await handleMessage(ADMIN_PHONE, `submitbatch ${batch!.ref}`);
    await handleMessage(SUPER_PHONE, `recordcheque ${batch!.ref} 100`);

    const res = await reconcileFromWebhook(coop.id, 10000, "TRX-1");
    expect(res.ok).toBe(true);
    const fresh = await prisma.deductionBatch.findUnique({ where: { ref: batch!.ref } });
    expect(fresh!.status).toBe("reconciled");
    expect(fresh!.reconciliationSource).toBe("webhook");
  });

  it("partial approval credits only what the reconciled amount covers", async () => {
    const coop = await makeCoop("DEDB10", "Partial Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const m1 = await makeMember(M1, coop.id);
    const m2 = await makeMember(M2, coop.id);
    await handleMessage(ADMIN_PHONE, `setcommit ${m1.code} 10000`);
    await handleMessage(ADMIN_PHONE, `setcommit ${m2.code} 10000`);
    await handleMessage(ADMIN_PHONE, "newbatch");
    const batch = await prisma.deductionBatch.findFirst();
    await handleMessage(ADMIN_PHONE, `submitbatch ${batch!.ref}`);
    await handleMessage(SUPER_PHONE, `confirmname ${admin.code}`);
    await handleMessage(SUPER_PHONE, `recordcheque ${batch!.ref} 200`);
    await handleMessage(SUPER_PHONE, `reconbatch ${batch!.ref} 100`); // only ₦100 arrived

    vi.clearAllMocks();
    await handleMessage(SUPER_PHONE, `approvebatch ${batch!.ref}`);
    expect(texts()).toContain("reconciled short");

    await handleMessage(SUPER_PHONE, `approvebatch ${batch!.ref} partial`);
    const fresh = await prisma.deductionBatch.findUnique({ where: { ref: batch!.ref } });
    expect(fresh!.status).toBe("partially_approved");
    const credited = await prisma.deductionItem.count({
      where: { batchId: batch!.id, status: "credited" },
    });
    expect(credited).toBe(1);
    const wallets = await prisma.wallet.findMany({
      where: { memberId: { in: [m1.id, m2.id] } },
    });
    expect(wallets.reduce((s, w) => s + w.balance, 0)).toBe(10000);
  });

  it("reconciles a cheque_received batch from an uploaded statement", async () => {
    const coop = await makeCoop("DEDB11", "Statement Coop", SUPER_PHONE);
    await makeMember(SUPER_PHONE, coop.id, { role: "superadmin" });
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const m = await makeMember(M1, coop.id);
    await handleMessage(ADMIN_PHONE, `setcommit ${m.code} 10000`);
    await handleMessage(ADMIN_PHONE, "newbatch");
    const batch = await prisma.deductionBatch.findFirst();
    await handleMessage(ADMIN_PHONE, `submitbatch ${batch!.ref}`);
    await handleMessage(SUPER_PHONE, `recordcheque ${batch!.ref} 100`);

    const csv = "Date,Description,Credit\n2026-10-01,EMPLOYER REMIT,100\n";
    const res = await reconcileFromStatement(coop.id, Buffer.from(csv), "statement.csv");
    expect(res.ok).toBe(true);
    expect(res.reconciled).toContain(batch!.ref);
    const fresh = await prisma.deductionBatch.findUnique({ where: { ref: batch!.ref } });
    expect(fresh!.status).toBe("reconciled");
    expect(fresh!.reconciliationSource).toBe("statement");
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
      vi
        .mocked(sendText)
        .mock.calls.map((c) => c[0].to)
        .includes(M1),
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
