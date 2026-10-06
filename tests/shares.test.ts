import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  createTestCoop,
  createTestMember,
  createTestApp,
  cleanupDatabase,
} from "./setup.js";
import { buyShares, getShareAccount } from "../src/services/shares.js";
import { distributeDividend } from "../src/services/dividends.js";
import { clearMemberCache } from "../src/services/cooperative.js";
import { paymentState } from "./payment-state.js";
import { recordLedger } from "../src/services/ledger.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";

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
});

afterAll(cleanupDatabase);

describe("share capital", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanupDatabase();
  });

  it("buys shares from the wallet and posts a balanced journal", async () => {
    const coop = await createTestCoop("SHARE1");
    const member = await createTestMember(coop.id, { phone: "2348000000001" });
    await fundWallet(member.id, 500000); // ₦5,000

    const result = await buyShares(member.id, 3); // 3 × ₦1,000 = ₦3,000
    expect(result.ok).toBe(true);

    const account = await prisma.shareAccount.findFirst({ where: { memberId: member.id } });
    expect(account?.shares).toBe(3);
    expect(account?.totalPaid).toBe(300000);

    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet?.balance).toBe(200000); // ₦5,000 − ₦3,000

    const postings = await prisma.posting.findMany();
    const debit = postings.filter((p) => p.direction === "DEBIT").reduce((s, p) => s + p.amount, 0);
    const credit = postings.filter((p) => p.direction === "CREDIT").reduce((s, p) => s + p.amount, 0);
    expect(debit).toBe(credit);
    expect(postings.some((p) => p.account === "equity:share_capital")).toBe(true);
  });

  it("refuses a purchase the wallet cannot cover", async () => {
    const coop = await createTestCoop("SHARE2");
    const member = await createTestMember(coop.id, { phone: "2348000000002" });
    await fundWallet(member.id, 50000); // ₦500

    const result = await buyShares(member.id, 1); // costs ₦1,000
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/save/i);
    expect(await prisma.shareAccount.findFirst({ where: { memberId: member.id } })).toBeNull();
  });

  it("reports the share account value", async () => {
    const coop = await createTestCoop("SHARE3");
    const member = await createTestMember(coop.id, { phone: "2348000000003" });
    await fundWallet(member.id, 500000);
    await buyShares(member.id, 2);

    const account = await getShareAccount(member.id);
    expect(account?.shares).toBe(2);
    expect(account?.value).toBe(200000);
  });

  it("appropriates statutory funds only once across savings and share dividends", async () => {
    const coop = await createTestCoop("DIVSHARED");
    const admin = await createTestMember(coop.id, { phone: "2348000000300", role: "superadmin" });
    const NAME = "Dual Holder";
    const a = await createTestMember(coop.id, { phone: "2348000000301", name: NAME });
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
      reference: `TEST-SHARED-${Date.now()}`,
    });

    const savings = await distributeDividend(admin.phone, 10); // savings basis
    expect(savings.ok).toBe(true);
    const shares = await distributeDividend(admin.phone, 10, "shares");
    expect(shares.ok).toBe(true);

    // Statutory 20/2/5% of 1,000,000 taken exactly once = 270,000.
    const reserve = await prisma.reserveAllocation.aggregate({ where: { cooperativeId: coop.id }, _sum: { amount: true } });
    const education = await prisma.educationFund.aggregate({ where: { cooperativeId: coop.id }, _sum: { amount: true } });
    const development = await prisma.developmentFund.aggregate({ where: { cooperativeId: coop.id }, _sum: { amount: true } });
    expect(reserve._sum.amount).toBe(200000);
    expect(education._sum.amount).toBe(20000);
    expect(development._sum.amount).toBe(50000);

    // Combined pools never exceed net profit minus statutory.
    expect((savings.totalPool ?? 0) + (shares.totalPool ?? 0)).toBeLessThanOrEqual(1000000 - 270000);
  });

  it("manual reserve allocations do not suppress statutory appropriations", async () => {
    const coop = await createTestCoop("DIVMANUAL");
    const admin = await createTestMember(coop.id, { phone: "2348000000400", role: "superadmin" });
    const NAME = "Manual Holder";
    const a = await createTestMember(coop.id, { phone: "2348000000401", name: NAME });
    await prisma.member.update({
      where: { id: a.id },
      data: { bankAccountNumber: "0123456789", bankCode: "058", bankName: "GTBank" },
    });
    await fundWallet(a.id, 1000000);
    paymentState.resolveName = NAME;
    await recordLedger({
      cooperativeId: coop.id,
      type: "income",
      category: "interest",
      amount: 1000000,
      note: "Test profit",
      reference: `TEST-MANUAL-${Date.now()}`,
    });
    // A superadmin tops up the reserve fund OUTSIDE any dividend run.
    await prisma.reserveAllocation.create({
      data: { cooperativeId: coop.id, amount: 123456, source: "manual", note: "Manual top-up" },
    });

    const result = await distributeDividend(admin.phone, 10);
    expect(result.ok).toBe(true);

    // The dividend run still takes the full 20/2/5% statutory slice.
    const reserve = await prisma.reserveAllocation.aggregate({
      where: { cooperativeId: coop.id, source: "dividend_declaration" },
      _sum: { amount: true },
    });
    const education = await prisma.educationFund.aggregate({
      where: { cooperativeId: coop.id },
      _sum: { amount: true },
    });
    const development = await prisma.developmentFund.aggregate({
      where: { cooperativeId: coop.id },
      _sum: { amount: true },
    });
    expect(reserve._sum.amount).toBe(200000);
    expect(education._sum.amount).toBe(20000);
    expect(development._sum.amount).toBe(50000);
  });
});

describe("shares chat commands", () => {
  it("buys shares via the chat command", async () => {
    const coop = await createTestCoop("SHARECHAT");
    const member = await createTestMember(coop.id, { phone: "2348000000099" });
    await fundWallet(member.id, 500000);

    await handleMessage(member.phone, "buyshares 2");
    await handleMessage(member.phone, "1234");

    const account = await prisma.shareAccount.findFirst({ where: { memberId: member.id } });
    expect(account?.shares).toBe(2);
    const calls = vi.mocked(sendText).mock.calls.map((c) => c[0].text).join("\n");
    expect(calls).toMatch(/share/i);
  });

  it("does not buy shares on a wrong PIN", async () => {
    const coop = await createTestCoop("SHARECHAT2");
    const member = await createTestMember(coop.id, { phone: "2348000000098" });
    await fundWallet(member.id, 500000);

    await handleMessage(member.phone, "buyshares 2");
    await handleMessage(member.phone, "0000");

    const account = await prisma.shareAccount.findFirst({ where: { memberId: member.id } });
    expect(account?.shares ?? 0).toBe(0);
  });

  it("blocks buyshares for a frozen member", async () => {
    const coop = await createTestCoop("SHARECHAT3");
    const member = await createTestMember(coop.id, { phone: "2348000000097" });
    await fundWallet(member.id, 500000);
    await prisma.member.update({ where: { id: member.id }, data: { frozenAt: new Date() } });

    await handleMessage(member.phone, "buyshares 2");
    await handleMessage(member.phone, "1234");

    const account = await prisma.shareAccount.findFirst({ where: { memberId: member.id } });
    expect(account?.shares ?? 0).toBe(0);
    const wallet = await prisma.wallet.findUnique({ where: { memberId: member.id } });
    expect(wallet?.balance).toBe(500000);
  });

  it("blocks buyshares for a suspended member", async () => {
    const coop = await createTestCoop("SHARECHAT4");
    const member = await createTestMember(coop.id, { phone: "2348000000096" });
    await fundWallet(member.id, 500000);
    await prisma.member.update({ where: { id: member.id }, data: { status: "suspended" } });

    await handleMessage(member.phone, "buyshares 2");
    await handleMessage(member.phone, "1234");

    const account = await prisma.shareAccount.findFirst({ where: { memberId: member.id } });
    expect(account?.shares ?? 0).toBe(0);
  });
});

describe("share dividend (bank payout)", () => {
  it("pays shareholders to their bank by shareholding", async () => {
    const coop = await createTestCoop("SHAREDIV");
    const admin = await createTestMember(coop.id, { phone: "2348000000100", role: "superadmin" });
    const NAME = "Share Holder";
    const a = await createTestMember(coop.id, { phone: "2348000000101", name: NAME });
    const b = await createTestMember(coop.id, { phone: "2348000000102", name: NAME });
    for (const m of [a, b]) {
      await prisma.member.update({
        where: { id: m.id },
        data: { bankAccountNumber: "0123456789", bankCode: "058", bankName: "GTBank" },
      });
      await fundWallet(m.id, 1000000);
    }
    await buyShares(a.id, 3);
    await buyShares(b.id, 1);
    paymentState.resolveName = NAME;
    await recordLedger({
      cooperativeId: coop.id,
      type: "income",
      category: "interest",
      amount: 1000000,
      note: "Test profit",
      reference: `TEST-${Date.now()}`,
    });

    const result = await distributeDividend(admin.phone, 20, "shares");
    expect(result.ok).toBe(true);
    expect(result.settled).toBe(2);

    const entries = await prisma.dividendEntry.findMany({
      where: { dividendId: result.dividendId! },
    });
    const aEntry = entries.find((e) => e.memberId === a.id)!;
    const bEntry = entries.find((e) => e.memberId === b.id)!;
    // a holds 3 of 4 shares → gets ~3× b's dividend
    expect(aEntry.amount).toBeGreaterThan(bEntry.amount);
    expect(aEntry.amount + bEntry.amount).toBe(result.totalPool);
  });
});

describe("shares admin endpoint", () => {
  it("lists share accounts for the cooperative", async () => {
    const coop = await createTestCoop("SHAREAPI");
    const admin = await createTestMember(coop.id, { phone: "2348000000200", role: "superadmin", pin: "1234" });
    const m = await createTestMember(coop.id, { phone: "2348000000201" });
    await fundWallet(m.id, 500000);
    await buyShares(m.id, 2);

    const app = await createTestApp();
    const login = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { "x-requested-with": "xmlhttprequest" },
      payload: { phone: admin.phone, pin: "1234" },
    });
    const cookie = login.headers["set-cookie"] as string;

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/shares",
      headers: { cookie, "x-requested-with": "xmlhttprequest" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.totalShares).toBe(2);
  });
});
