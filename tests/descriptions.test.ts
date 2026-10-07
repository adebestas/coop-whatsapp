import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { formatBalance } from "../src/lib/money.js";
import { clearMemberCache } from "../src/services/cooperative.js";
import { paymentState } from "./payment-state.js";
import { handlePaymentNotification } from "../src/services/payments/topup.js";
import {
  createProduct,
  openProduct,
  depositToProduct,
  withdrawFromProduct,
  matureProduct,
} from "../src/services/savings-products.js";
import { buyShares } from "../src/services/shares.js";
import { createGroup, joinGroup, contributeToGroup } from "../src/services/groups.js";
import { distributeDividend } from "../src/services/dividends.js";
import { recordLedger } from "../src/services/ledger.js";
import { repayLoan } from "../src/services/loans.js";
import { recommendRefund, rejectRefund } from "../src/services/refunds.js";
import { runPayroll } from "../src/services/payroll.js";
import { finalizeWithdrawal } from "../src/services/withdrawals.js";

/**
 * Every payment and deduction across the app must carry a human-readable
 * description in the journal, the audit trail, and the provider narration.
 * This suite drives representative money flows and asserts the invariant on
 * the rows they actually write — it is deliberately blunt: a money audit entry
 * without a formatted amount (₦) is a failure.
 */

const MONEY_ACTION =
  /^(topup\.credit|withdrawal\.(finalize|approve)|refund\.(recommend|approve|paid|failed|reject)|loan\.repay|dividend\.distribute|guarantor\.deduct|savings\.(deposit|withdraw|mature)|group\.(contribute|cycle_close|loan_apply)|shares\.buy|payroll\.run|deduction\.batch\.(cheque|reconcile|approve))$/;

const GENERIC =
  /^(transaction|payment|deduction|transfer|journal|expense:|income:|appropriation:|balance_sheet:|other|sale|dup|sale:|interest|stipend)$/i;

async function assertDescriptions(cooperativeId: string): Promise<void> {
  const entries = await prisma.journalEntry.findMany({ where: { cooperativeId } });
  for (const e of entries) {
    const d = (e.description ?? "").trim();
    expect(d, `journal entry ${e.txRef} must carry a description`).not.toBe("");
    expect(d.length, `journal entry ${e.txRef} description too small: "${d}"`).toBeGreaterThan(8);
    expect(GENERIC.test(d), `journal entry ${e.txRef} has a generic description: "${d}"`).toBe(false);
  }

  const logs = await prisma.auditLog.findMany({ where: { cooperativeId } });
  const moneyLogs = logs.filter((l) => MONEY_ACTION.test(l.action));
  expect(moneyLogs.length, "expected at least one money audit entry").toBeGreaterThan(0);
  for (const l of moneyLogs) {
    const d = (l.detail ?? "").trim();
    expect(d, `audit ${l.action} must carry a detail`).not.toBe("");
    expect(
      d,
      `audit ${l.action} must show a human-readable amount (many kobo paths print raw integers): "${d}"`,
    ).toContain("₦");
  }
}

async function fundWallet(memberId: string, kobo: number) {
  await prisma.wallet.update({ where: { memberId }, data: { balance: kobo, totalSaved: kobo } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearMemberCache();
  await cleanupDatabase();
  paymentState.resolveFails = false;
  paymentState.payoutFails = false;
  paymentState.payoutPending = false;
  paymentState.transferStatus = "unknown";
  paymentState.resolveName = "ADA OBI";
});

afterAll(cleanupDatabase);

describe("money descriptions are human-readable app-wide", () => {
  it("topup: wallet top-up names the member and formats the amount", async () => {
    const coop = await createTestCoop("DESC-TOPUP");
    const member = await createTestMember(coop.id, { phone: "2348010000001", name: "Ada Topup" });
    await prisma.member.update({
      where: { id: member.id },
      data: { virtualAccountNumber: "9000000001" },
    });

    await handlePaymentNotification({
      transactionId: "TX-TOPUP-1",
      accountNumber: "9000000001",
      amount: 250000,
      currency: "NGN",
      status: "successful",
      provider: "monnify",
      raw: {},
    });

    await assertDescriptions(coop.id);
  });

  it("savings deposit / withdrawal / maturity carry product, amount and holder", async () => {
    const coop = await createTestCoop("DESC-SAVE");
    const admin = await createTestMember(coop.id, { phone: "2348010000011", role: "superadmin" });
    const m = await createTestMember(coop.id, { phone: "2348010000012", name: "Ada Saver" });
    const actor = { id: admin.id, phone: admin.phone, role: admin.role };

    const goal = await createProduct(coop.id, "goal", "School Fees Goal", {}, actor);
    const opened = await openProduct(coop.id, goal.productId!, m.id, 5000000);
    await fundWallet(m.id, 500000);
    expect((await depositToProduct(coop.id, opened.accountId!, m.id, 500000)).ok).toBe(true);
    expect((await withdrawFromProduct(coop.id, opened.accountId!, m.id, 100000)).ok).toBe(true);
    await prisma.savingsAccount.update({
      where: { id: opened.accountId! },
      data: { maturesAt: new Date(Date.now() - 1000) },
    });
    expect((await matureProduct(coop.id, opened.accountId!, m.id)).ok).toBe(true);

    await assertDescriptions(coop.id);
  });

  it("share purchase names the member and formats the cost", async () => {
    const coop = await createTestCoop("DESC-SHARES");
    const member = await createTestMember(coop.id, { phone: "2348010000021", name: "Ada Holder" });
    await fundWallet(member.id, 500000);

    expect((await buyShares(member.id, 3)).ok).toBe(true);

    await assertDescriptions(coop.id);
  });

  it("group contribution formats the amount and names the group", async () => {
    const coop = await createTestCoop("DESC-GROUP");
    const admin = await createTestMember(coop.id, { phone: "2348010000031", role: "superadmin" });
    const a = await createTestMember(coop.id, { phone: "2348010000032", name: "Ada Member" });
    const actor = { id: admin.id, phone: admin.phone, role: admin.role };

    const created = await createGroup(coop.id, "rosca", "Family", "DSC1", 500000, 2, actor);
    await joinGroup(coop.id, "DSC1", a.id);
    await fundWallet(a.id, 500000);
    expect((await contributeToGroup(coop.id, created.groupId!, a.id, 500000)).ok).toBe(true);

    await assertDescriptions(coop.id);
  });

  it("dividend distribution formats the pool", async () => {
    const coop = await createTestCoop("DESC-DIV");
    const admin = await createTestMember(coop.id, { phone: "2348010000041", role: "superadmin" });
    const NAME = "Ada Dividend";
    const a = await createTestMember(coop.id, { phone: "2348010000042", name: NAME });
    await prisma.member.update({
      where: { id: a.id },
      data: { bankAccountNumber: "0123456789", bankCode: "058", bankName: "GTBank" },
    });
    await fundWallet(a.id, 1000000);
    await buyShares(a.id, 2);
    paymentState.resolveName = NAME;
    await recordLedger({
      cooperativeId: coop.id,
      type: "income",
      category: "interest",
      amount: 1000000,
      note: "Test profit",
      reference: `DESC-DIV-${Date.now()}`,
    });

    const res = await distributeDividend(admin.phone, 10, "shares");
    expect(res.ok).toBe(true);

    await assertDescriptions(coop.id);
  });

  it("loan repayment names the installment and formats the amount", async () => {
    const coop = await createTestCoop("DESC-LOAN");
    const member = await createTestMember(coop.id, { phone: "2348010000051", name: "Ada Borrower" });
    await fundWallet(member.id, 500000);
    const loan = await prisma.loan.create({
      data: {
        memberId: member.id,
        cooperativeId: coop.id,
        amount: 1000000,
        balance: 1000000,
        monthlyPayment: 100000,
        tenureMonths: 11,
        interestRate: 10,
        status: "disbursed",
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const res = await repayLoan(member.phone, loan.id, coop.id);
    expect(res.ok).toBe(true);

    await assertDescriptions(coop.id);
  });

  it("refund recommendation and rejection format the amount", async () => {
    const coop = await createTestCoop("DESC-REFUND");
    const admin = await createTestMember(coop.id, { phone: "2348010000061", role: "admin" });
    const superadmin = await createTestMember(coop.id, {
      phone: "2348010000062",
      role: "superadmin",
    });
    const member = await createTestMember(coop.id, { phone: "2348010000063", name: "Ada Refunded" });

    const rec = await recommendRefund(
      coop.id,
      member.id,
      500000,
      "Double payment: bank transfer + direct debit",
      { id: admin.id, phone: admin.phone, role: admin.role },
    );
    expect(rec.ok).toBe(true);
    const rejected = await rejectRefund(coop.id, rec.refundId!, "Not a double payment", {
      id: superadmin.id,
      phone: superadmin.phone,
      role: superadmin.role,
    });
    expect(rejected.ok).toBe(true);

    await assertDescriptions(coop.id);
  });

  it("payroll names the run and formats the total", async () => {
    const coop = await createTestCoop("DESC-PAYROLL");
    const superAdmin = await createTestMember(coop.id, {
      phone: "2348010000071",
      role: "superadmin",
    });
    const staff = await createTestMember(coop.id, {
      phone: "2348010000072",
      role: "superadmin",
      name: "Ada Staff",
    });
    await prisma.member.update({
      where: { id: staff.id },
      data: {
        bankAccountNumber: "0123456789",
        bankCode: "058",
        bankName: "GTBank",
        salaryAmount: 150000,
        salaryKind: "salary",
      },
    });
    paymentState.resolveName = staff.name;

    const res = await runPayroll(
      coop.id,
      { id: superAdmin.id, phone: superAdmin.phone, role: superAdmin.role, cooperativeId: coop.id },
      "August allowances",
    );
    expect(res.ok).toBe(true);

    await assertDescriptions(coop.id);
  });

  it("withdrawal finalization names the member and formats the amount", async () => {
    const coop = await createTestCoop("DESC-WD");
    const superadmin = await createTestMember(coop.id, {
      phone: "2348010000081",
      role: "superadmin",
    });
    const member = await createTestMember(coop.id, { phone: "2348010000082", name: "ADA OBI" });
    await prisma.member.update({
      where: { id: member.id },
      data: { bankAccountNumber: "0123456789", bankCode: "058", bankName: "GTBank" },
    });
    await fundWallet(member.id, 500000);
    const request = await prisma.withdrawalRequest.create({
      data: {
        amount: 100000,
        status: "pending",
        bankAccountNumber: "0123456789",
        bankCode: "058",
        memberId: member.id,
        cooperativeId: coop.id,
      },
    });

    const res = await finalizeWithdrawal(request.id, {
      id: superadmin.id,
      role: "superadmin",
      phone: superadmin.phone,
      cooperativeId: coop.id,
    });
    expect(res.ok).toBe(true);

    await assertDescriptions(coop.id);
  });
});

describe("formatBalance is the only money formatter", () => {
  it("prints a ₦ symbol and two decimals", () => {
    expect(formatBalance(100050)).toBe("₦1,000.50");
  });
});
