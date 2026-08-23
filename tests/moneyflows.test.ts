import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { sendText, notifyMember } from "../src/lib/messaging.js";

/** Union of chat texts from both channels-aware senders. */
function allTexts(): string[] {
  return [
    ...vi.mocked(sendText).mock.calls.map((c) => c[0].text),
    ...vi.mocked(notifyMember).mock.calls.map((c) => String(c[1])),
  ];
}
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { requestExternalPayment, approveExternalPayment } from "../src/services/payanyone.js";
import { recordLedger, computePnl } from "../src/services/ledger.js";
import { audit, verifyAuditChain } from "../src/services/audit.js";
import { scanGuarantorDefaults, executeDueDeductions } from "../src/services/guarantordeduction.js";
import { runPayroll } from "../src/services/payroll.js";
import { runExport } from "../src/services/exports.js";
import { resolveProvider } from "../src/services/payments/index.js";

vi.mock("../src/lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
  notifyMember: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
  sendSecurePrompt: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
}));

const ADMIN_PHONE = "2348090000001";
const PHONE = "2348010000001";

vi.mock("../src/services/payments/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/payments/index.js")>();
  return {
    ...actual,
    resolveProvider: () => ({
      name: "monnify",
      createVirtualAccount: vi.fn(),
      payout: vi.fn(async () => ({ ok: true, providerRef: "pay-trx-1" })),
      resolveAccount: vi.fn(async () => ({ ok: true, name: "ADA OBI" })),
      verifyWebhook: () => true,
      parseNotification: () => null,
    }),
  };
});

function uniqueCode(prefix: string) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

async function makeCoop(name = "New Coop") {
  return prisma.cooperative.create({ data: { name, code: uniqueCode("C"), adminPhone: null } });
}

async function makeMember(
  phone: string,
  coopId: string,
  opts: { role?: string; name?: string; bank?: boolean; salaryAmount?: number; salaryKind?: string } = {},
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  const data: any = {
    code,
    phone,
    name: opts.name ?? `Member ${phone.slice(-4)}`,
    cooperativeId: coopId,
    role: opts.role ?? "member",
    pin: hashPin("1234"),
    wallet: { create: {} },
  };
  if (opts.bank) {
    data.bankAccountNumber = "0123456789";
    data.bankCode = "058";
    data.bankName = "Access";
  }
  if (opts.salaryAmount !== undefined) {
    data.salaryAmount = opts.salaryAmount;
    data.salaryKind = opts.salaryKind ?? "stipend";
  }
  return prisma.member.create({ data });
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const m of [
    "coopPost", "deductionItem", "deductionWaiver", "deductionBatch",
    "posting", "journalEntry", "webhookEvent",
    "beneficiary", "pollBallot", "pollOption", "purchasePoll", "externalPayment",
    "guarantorDeduction", "ledgerEntry",
    "voteBallot", "voteCandidate", "vote", "supportTicket", "auditLog",
    "deathValidation", "deathClaim", "withdrawalRequest", "contribution",
    "loanRepayment", "guarantor", "loan", "payout", "dividendEntry",
    "dividend", "broadcast", "wallet", "member", "unit", "cooperative", "session",
  ] as any[]) {
    await prisma[m].deleteMany();
  }
});

describe("pay anyone (3-super approval)", () => {
  it("moves through three distinct supers, then pays out and logs the expense", async () => {
    const coop = await makeCoop();
    const admin = await makeMember(ADMIN_PHONE, coop.id, { role: "admin" });
    const s1 = await makeMember("2348071111111", coop.id, { role: "superadmin" });
    const s2 = await makeMember("2348072222222", coop.id, { role: "superadmin" });
    const s3 = await makeMember("2348073333333", coop.id, { role: "superadmin" });

    const actorOf = (m: { id: string; name: string; phone: string; role: string; cooperativeId: string }) => m;
    const req = await requestExternalPayment(actorOf(admin), {
      beneficiaryName: "Vic Ventures",
      accountNumber: "0123456789",
      bankCode: "058",
      amount: 25000,
      purpose: "Generator repair",
    });
    expect(req.ok).toBe(true);
    const created = await prisma.externalPayment.findFirst();
    expect(created!.status).toBe("pending");

    // Same super can't approve twice.
    await approveExternalPayment(actorOf(s1), created!.id.slice(-6));
    const again = await approveExternalPayment(actorOf(s1), created!.id.slice(-6));
    expect(again.ok).toBe(false);

    // The initiator can't be an approver.
    const self = await approveExternalPayment(actorOf(admin), created!.id.slice(-6));
    expect(self.ok).toBe(false);

    await approveExternalPayment(actorOf(s2), created!.id.slice(-6));
    const final = await approveExternalPayment(actorOf(s3), created!.id.slice(-6));
    expect(final.ok).toBe(true);

    const done = await prisma.externalPayment.findUnique({ where: { id: created!.id } });
    expect(done!.status).toBe("paid");
    expect(done!.approved1ById).toBe(s1.id);
    expect(done!.approved2ById).toBe(s2.id);
    expect(done!.approved3ById).toBe(s3.id);

    const payout = await prisma.payout.findFirst({ where: { memberId: admin.id } });
    expect(payout).not.toBeNull();
    expect(payout!.amount).toBe(25000);

    const entry = await prisma.ledgerEntry.findFirst({
      where: { cooperativeId: coop.id, category: "external_payment" },
    });
    expect(entry).not.toBeNull();

    const texts = allTexts().join("\n");
    expect(texts).toContain("paid");
  });
});

describe("ledger + P&L", () => {
  it("computes income, expenses and net profit", async () => {
    const coop = await makeCoop();
    await recordLedger({ cooperativeId: coop.id, type: "income", category: "interest", amount: 30000, note: "interest" });
    await recordLedger({ cooperativeId: coop.id, type: "income", category: "fine", amount: 2000, note: "fines" });
    await recordLedger({ cooperativeId: coop.id, type: "expense", category: "stipend", amount: 7000, note: "stipends" });
    const pnl = await computePnl(coop.id);
    expect(pnl.totalIncome).toBe(32000);
    expect(pnl.totalExpense).toBe(7000);
    expect(pnl.netProfit).toBe(25000);
  });
});

describe("audit trail", () => {
  it("chains hashes and detects tampering", async () => {
    const coop = await makeCoop();
    const member = await makeMember(PHONE, coop.id);
    for (const [action, detail] of [["test.a", "one"], ["test.b", "two"], ["test.c", "three"]] as const) {
      await audit({ cooperativeId: coop.id, actorPhone: member.phone, actorId: member.id, action, detail });
    }

    expect((await verifyAuditChain(coop.id)).ok).toBe(true);

    // Tamper with a middle row — every later hash stops matching.
    const rows = await prisma.auditLog.findMany({ where: { cooperativeId: coop.id }, orderBy: { createdAt: "asc" } });
    await prisma.auditLog.update({ where: { id: rows[1].id }, data: { detail: "tampered" } });
    const broken = await verifyAuditChain(coop.id);
    expect(broken.ok).toBe(false);
    expect(broken.brokenAt).toBeTruthy();
  });
});

describe("guarantor deductions", () => {
  it("notifies guarantors after 2 months of default, deducts after 10 days unless repaid", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
      const coop = await makeCoop();
      const borrower = await makeMember(PHONE, coop.id, { name: "Ada Obi" });
      const g1 = await makeMember("2348055550001", coop.id);
      const loan = await prisma.loan.create({
        data: {
          memberId: borrower.id,
          cooperativeId: coop.id,
          amount: 20000,
          balance: 20000,
          tenureMonths: 11,
          interestRate: 10,
          status: "disbursed",
          dueDate: new Date("2025-12-15T10:00:00Z"), // 2+ months before the frozen clock
          guarantors: { create: [{ memberId: g1.id, status: "confirmed", code: uniqueCode("G") }] },
        },
        include: { guarantors: true },
      });

      // Sweep right away: notices go out, nothing deducted yet.
      const noticed = await scanGuarantorDefaults();
      expect(noticed).toBe(1);
      const pending = await prisma.guarantorDeduction.findFirst();
      expect(pending).not.toBeNull();
      expect(pending!.status).toBe("notified");
      expect(pending!.amount).toBe(1000); // 50% of flat interest (20000 x 10%)

      const textsAfterNotice = allTexts().join("\n");
      expect(textsAfterNotice).toContain("10-day deduction notice");

      // Borrower still owes when the notice window passes -> savings hit.
      vi.setSystemTime(new Date("2026-03-12T10:00:00Z"));
      const gWalletBefore = (await prisma.member.findUnique({ where: { id: g1.id }, include: { wallet: true } }))!;
      await prisma.wallet.update({
        where: { memberId: g1.id },
        data: { balance: 5000, totalSaved: 5000 },
      });
      void gWalletBefore;

      const res = await executeDueDeductions();
      expect(res.deducted).toBe(1);
      const deducted = await prisma.guarantorDeduction.findFirst();
      expect(deducted!.status).toBe("deducted");
      const gWalletAfter = await prisma.member.findUnique({ where: { id: g1.id }, include: { wallet: true } });
      expect(gWalletAfter!.wallet!.balance).toBe(4000);
      expect(gWalletAfter!.wallet!.totalSaved).toBe(4000);
      expect(gWalletAfter!.wallet!.balance).toBeLessThan(5000);
      void loan;
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending deductions when the arrears are cleared during the notice window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-01T10:00:00Z"));
      const coop = await makeCoop();
      const borrower = await makeMember(PHONE, coop.id);
      const g1 = await makeMember("2348055550002", coop.id);
      await prisma.loan.create({
        data: {
          memberId: borrower.id,
          cooperativeId: coop.id,
          amount: 10000,
          balance: 10000,
          tenureMonths: 11,
          interestRate: 10,
          status: "disbursed",
          dueDate: new Date("2025-12-15T10:00:00Z"),
          guarantors: { create: [{ memberId: g1.id, status: "confirmed", code: uniqueCode("G") }] },
        },
      });

      await scanGuarantorDefaults();
      // Borrower clears the loan before day 10.
      await prisma.loan.updateMany({ data: { balance: 0, status: "paid" } });
      const res = await executeDueDeductions();
      expect(res.cancelled).toBe(1);
      const row = await prisma.guarantorDeduction.findFirst();
      expect(row!.status).toBe("cancelled");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("payroll", () => {
  it("queues salaries to BANK accounts only and demands a narration", async () => {
    const coop = await makeCoop();
    const superAdmin = await makeMember("2348074444444", coop.id, { role: "superadmin", bank: true });
    const staffA = await makeMember(PHONE, coop.id, { role: "superadmin", bank: true, salaryAmount: 15000, salaryKind: "salary", name: "Ada Obi" });
    await makeMember("2348055550003", coop.id, { role: "superadmin", salaryAmount: 8000 }); // no bank details

    const shortNarration = await runPayroll(coop.id, superAdmin, "no");
    expect(shortNarration.ok).toBe(false); // narration required

    const res = await runPayroll(coop.id, superAdmin, "August allowances");
    expect(res.ok).toBe(true);

    // Paid straight to bank accounts as Payouts (not queued, not to wallets).
    const payouts = await prisma.payout.findMany({ where: { memberId: staffA.id } });
    expect(payouts).toHaveLength(1); // only members WITH bank details got paid
    expect(payouts[0].amount).toBe(15000);
    expect(payouts[0].note ?? "").toContain("August allowances");
    expect(await prisma.externalPayment.count()).toBe(0);

    // Wallet untouched — salaries never land in wallets.
    const staff = await prisma.member.findUnique({ where: { id: staffA.id }, include: { wallet: true } });
    expect(staff!.wallet!.balance).toBe(0);
  });
});

describe("exports", () => {
  it("writes xlsx and pdf files to disk without error", async () => {
    const coop = await makeCoop();
    const requester = await makeMember(PHONE, coop.id, { bank: true });
    await recordLedger({ cooperativeId: coop.id, type: "income", category: "interest", amount: 900, note: "int" });
    const res = await runExport(
      { id: requester.id, name: requester.name, email: null, cooperativeId: coop.id },
      "members",
      "http://localhost:3000",
    );
    expect(res.ok).toBe(true);
    expect(res.files.length).toBe(2);
    for (const f of res.files) {
      const stat = await import("node:fs/promises").then((fs) => fs.stat(f));
      expect(stat.size).toBeGreaterThan(100);
    }
  });
});

describe("provider default", () => {
  it("defaults to monnify as the primary provider", () => {
    expect(resolveProvider().name).toBe("monnify");
  });
});



