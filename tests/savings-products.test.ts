import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import {
  createProduct,
  listProducts,
  openProduct,
  depositToProduct,
  withdrawFromProduct,
  matureProduct,
  listMemberProducts,
  productProgress,
} from "../src/services/savings-products.js";
import { notifyMember, sendText } from "../src/lib/messaging.js";
import { clearMemberCache } from "../src/services/cooperative.js";
import { handleAdminCommand } from "../src/services/admin.js";
import { handleMessage } from "../src/services/conversation.js";

const actor = (m: { id: string; phone: string; role: string }) => ({
  id: m.id,
  phone: m.phone,
  role: m.role,
});

async function fundWallet(memberId: string, kobo: number) {
  await prisma.wallet.update({ where: { memberId }, data: { balance: kobo } });
}

async function walletBalance(memberId: string): Promise<number> {
  return (await prisma.wallet.findUnique({ where: { memberId } }))?.balance ?? 0;
}

async function postingsBalance(): Promise<{ debit: number; credit: number }> {
  const postings = await prisma.posting.findMany();
  return {
    debit: postings.filter((p) => p.direction === "DEBIT").reduce((s, p) => s + p.amount, 0),
    credit: postings.filter((p) => p.direction === "CREDIT").reduce((s, p) => s + p.amount, 0),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearMemberCache();
  await cleanupDatabase();
});

afterAll(cleanupDatabase);

describe("savings products", () => {
  it("opens a goal product, tracks progress against the target and notifies at 100%", async () => {
    const coop = await createTestCoop("SAVE1");
    const admin = await createTestMember(coop.id, { phone: "2348000020001", role: "superadmin" });
    const m = await createTestMember(coop.id, { phone: "2348000020002" });

    const created = await createProduct(coop.id, "goal", "School Fees", { minAmount: 0 }, actor(admin));
    expect(created.ok).toBe(true);
    expect(created.productId).toBeTruthy();

    const opened = await openProduct(coop.id, created.productId!, m.id, 100000);
    expect(opened.ok).toBe(true);
    expect(opened.accountId).toBeTruthy();

    await fundWallet(m.id, 100000);

    const dep = await depositToProduct(coop.id, opened.accountId!, m.id, 60000);
    expect(dep.ok).toBe(true);
    expect(await walletBalance(m.id)).toBe(40000);

    let account = await prisma.savingsAccount.findUnique({ where: { id: opened.accountId! } });
    let progress = productProgress(account!);
    expect(progress.balance).toBe(60000);
    expect(progress.target).toBe(100000);
    expect(progress.percent).toBe(60);
    expect(progress.complete).toBe(false);

    vi.clearAllMocks();
    const dep2 = await depositToProduct(coop.id, opened.accountId!, m.id, 40000);
    expect(dep2.ok).toBe(true);
    account = await prisma.savingsAccount.findUnique({ where: { id: opened.accountId! } });
    progress = productProgress(account!);
    expect(progress.balance).toBe(100000);
    expect(progress.percent).toBe(100);
    expect(progress.complete).toBe(true);

    const texts = vi
      .mocked(notifyMember)
      .mock.calls.map((c) => String(c[1]))
      .join("\n");
    expect(texts).toMatch(/goal/i);

    const books = await postingsBalance();
    expect(books.debit).toBe(books.credit);
  });

  it("matures a fixed deposit and credits principal + interest to the wallet", async () => {
    const coop = await createTestCoop("SAVE2");
    const admin = await createTestMember(coop.id, { phone: "2348000020011", role: "superadmin" });
    const m = await createTestMember(coop.id, { phone: "2348000020012" });

    const created = await createProduct(
      coop.id,
      "fixed",
      "12 Month Fixed",
      { interestRate: 10, termMonths: 12 },
      actor(admin),
    );
    expect(created.ok).toBe(true);

    const opened = await openProduct(coop.id, created.productId!, m.id);
    expect(opened.ok).toBe(true);
    const account = await prisma.savingsAccount.findUnique({ where: { id: opened.accountId! } });
    expect(account?.maturesAt).toBeInstanceOf(Date);

    await fundWallet(m.id, 500000);
    expect((await depositToProduct(coop.id, opened.accountId!, m.id, 500000)).ok).toBe(true);
    expect(await walletBalance(m.id)).toBe(0);

    // Bring maturity forward so we do not have to wait a year.
    await prisma.savingsAccount.update({
      where: { id: opened.accountId! },
      data: { maturesAt: new Date(Date.now() - 1000) },
    });

    const matured = await matureProduct(coop.id, opened.accountId!, m.id);
    expect(matured.ok).toBe(true);
    // 500000 principal + 10% interest = 550000.
    expect(await walletBalance(m.id)).toBe(550000);

    const after = await prisma.savingsAccount.findUnique({ where: { id: opened.accountId! } });
    expect(after?.status).toBe("matured");
    expect(after?.balance).toBe(0);

    const books = await postingsBalance();
    expect(books.debit).toBe(books.credit);
  });

  it("refuses to mature a fixed deposit before its term is up", async () => {
    const coop = await createTestCoop("SAVE3");
    const admin = await createTestMember(coop.id, { phone: "2348000020021", role: "superadmin" });
    const m = await createTestMember(coop.id, { phone: "2348000020022" });

    const created = await createProduct(
      coop.id,
      "fixed",
      "Long Fixed",
      { interestRate: 5, termMonths: 24 },
      actor(admin),
    );
    const opened = await openProduct(coop.id, created.productId!, m.id);
    await fundWallet(m.id, 100000);
    await depositToProduct(coop.id, opened.accountId!, m.id, 100000);

    const matured = await matureProduct(coop.id, opened.accountId!, m.id);
    expect(matured.ok).toBe(false);
    expect(await walletBalance(m.id)).toBe(0);
  });

  it("refuses a deposit larger than the wallet balance", async () => {
    const coop = await createTestCoop("SAVE4");
    const admin = await createTestMember(coop.id, { phone: "2348000020031", role: "superadmin" });
    const m = await createTestMember(coop.id, { phone: "2348000020032" });

    const created = await createProduct(coop.id, "goal", "Laptop", {}, actor(admin));
    const opened = await openProduct(coop.id, created.productId!, m.id, 500000);
    await fundWallet(m.id, 1000);

    const dep = await depositToProduct(coop.id, opened.accountId!, m.id, 5000);
    expect(dep.ok).toBe(false);
    expect(await walletBalance(m.id)).toBe(1000);

    const account = await prisma.savingsAccount.findUnique({ where: { id: opened.accountId! } });
    expect(account?.balance).toBe(0);
  });

  it("refuses a non-owner from depositing or withdrawing", async () => {
    const coop = await createTestCoop("SAVE5");
    const admin = await createTestMember(coop.id, { phone: "2348000020041", role: "superadmin" });
    const owner = await createTestMember(coop.id, { phone: "2348000020042" });
    const other = await createTestMember(coop.id, { phone: "2348000020043" });

    const created = await createProduct(coop.id, "goal", "Rent", {}, actor(admin));
    const opened = await openProduct(coop.id, created.productId!, owner.id, 200000);
    await fundWallet(owner.id, 200000);
    await depositToProduct(coop.id, opened.accountId!, owner.id, 100000);
    await fundWallet(other.id, 200000);

    const dep = await depositToProduct(coop.id, opened.accountId!, other.id, 10000);
    expect(dep.ok).toBe(false);
    const wd = await withdrawFromProduct(coop.id, opened.accountId!, other.id, 10000);
    expect(wd.ok).toBe(false);

    const account = await prisma.savingsAccount.findUnique({ where: { id: opened.accountId! } });
    expect(account?.balance).toBe(100000);
  });

  it("withdraws from an active account and credits the wallet", async () => {
    const coop = await createTestCoop("SAVE6");
    const admin = await createTestMember(coop.id, { phone: "2348000020051", role: "superadmin" });
    const m = await createTestMember(coop.id, { phone: "2348000020052" });

    const created = await createProduct(coop.id, "seasonal", "Harvest", { termMonths: 6 }, actor(admin));
    expect(created.ok).toBe(true);
    const products = await listProducts(coop.id);
    expect(products.ok).toBe(true);
    expect(products.products?.length).toBeGreaterThan(0);

    const opened = await openProduct(coop.id, created.productId!, m.id);
    await fundWallet(m.id, 100000);
    await depositToProduct(coop.id, opened.accountId!, m.id, 100000);

    const wd = await withdrawFromProduct(coop.id, opened.accountId!, m.id, 30000);
    expect(wd.ok).toBe(true);
    expect(await walletBalance(m.id)).toBe(30000);

    const mine = await listMemberProducts(coop.id, m.id);
    expect(mine.accounts?.some((a) => a.id === opened.accountId)).toBe(true);

    const books = await postingsBalance();
    expect(books.debit).toBe(books.credit);
  });
});

describe("savings product commands", () => {
  it("creates a product via the admin command and opens it via the member command", async () => {
    const coop = await createTestCoop("SAVE7");
    const admin = await createTestMember(coop.id, { phone: "2348000020061", role: "superadmin" });
    const m = await createTestMember(coop.id, { phone: "2348000020062" });

    await handleAdminCommand(admin.phone, "newproduct", ["fixed", "Festive", "8", "6"]);
    const product = await prisma.savingsProduct.findFirst({ where: { cooperativeId: coop.id } });
    expect(product).toBeTruthy();
    expect(product?.interestRate).toBe(8);
    expect(product?.termMonths).toBe(6);

    await handleMessage(admin.phone, "products");
    let texts = vi
      .mocked(sendText)
      .mock.calls.map((c) => c[0].text)
      .join("\n");
    expect(texts).toMatch(/Festive/);

    await handleMessage(m.phone, "products");
    texts = vi
      .mocked(sendText)
      .mock.calls.map((c) => c[0].text)
      .join("\n");
    expect(texts).toMatch(/Festive/);

    await handleMessage(m.phone, `openproduct ${product!.id}`);
    expect(await prisma.savingsAccount.count({ where: { memberId: m.id } })).toBe(1);
  });
});
