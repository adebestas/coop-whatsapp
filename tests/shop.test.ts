import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import { sendText, sendSecurePrompt } from "../src/lib/messaging.js";
import { notifyMember } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { clearMemberCache } from "../src/services/cooperative.js";
import { handleMessage } from "../src/services/conversation.js";
import { installmentSchedule, shopEligibility, createShopItem, createShopOrder, approveShopOrder, rejectShopOrder, dispatchShopOrder, runShopInstallments } from "../src/services/shop.js";

const PHONE = "2348070000001";

function lastText(): string {
  const calls = vi.mocked(sendText).mock.calls;
  return calls.length ? (calls[calls.length - 1][0] as { text: string }).text : "";
}

async function wipe(table: string) {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  } catch {}
}

beforeEach(async () => {
  for (const table of ["session", "shopOrder", "shopItem", "loanRepayment", "loan", "wallet", "member", "cooperative"]) {
    await wipe(table);
  }
  clearMemberCache();
  vi.mocked(sendText).mockClear();
  vi.mocked(sendSecurePrompt).mockClear();
  vi.mocked(notifyMember).mockClear();
});

async function seedMember(opts: { totalSaved?: number; role?: string; frozenAt?: Date | null } = {}) {
  const coop = await prisma.cooperative.create({
    data: { name: "Shop Test Coop", code: `SH${Date.now()}${Math.floor(Math.random() * 1000)}` },
  });
  const member = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: PHONE,
      name: "Ada Shop",
      code: generateMemberCode(),
      role: opts.role ?? "member",
      status: "active",
      consentAt: new Date(),
      frozenAt: opts.frozenAt ?? null,
      pin: hashPin("1234"),
      wallet: { create: { totalSaved: opts.totalSaved ?? 0 } },
    },
    include: { wallet: true },
  });
  return { coop, member, wallet: member.wallet! };
}

async function seedItem(coopId: string, createdById: string, over: Partial<{ name: string; cashPrice: number; maxMonths: number; stockQty: number | null }> = {}) {
  return prisma.shopItem.create({
    data: {
      cooperativeId: coopId,
      createdById,
      name: over.name ?? "50kg Rice",
      cashPrice: over.cashPrice ?? 8800000,
      maxMonths: over.maxMonths ?? 3,
      stockQty: over.stockQty === undefined ? null : over.stockQty,
    },
  });
}

async function seedShopLoan(opts: {
  coopId: string;
  memberId: string;
  balance: number;
  monthlyPayment: number;
  dueDate: Date;
}) {
  return prisma.loan.create({
    data: {
      amount: 3000000,
      balance: opts.balance,
      monthlyPayment: opts.monthlyPayment,
      interestRate: 0,
      tenureMonths: 3,
      status: "disbursed",
      kind: "shop",
      adminCharge: 0,
      dueDate: opts.dueDate,
      memberId: opts.memberId,
      cooperativeId: opts.coopId,
    },
  });
}

describe("installment schedule", () => {
  it("splits the price exactly, remainder on the last installment", () => {
    expect(installmentSchedule(8800000, 3)).toEqual({ monthly: 2933333, last: 2933334 });
    expect(installmentSchedule(100000, 1)).toEqual({ monthly: 100000, last: 100000 });
  });
});

describe("eligibility", () => {
  it("allows an order within 50% of savings", async () => {
    const { member } = await seedMember({ totalSaved: 2000000 });
    const res = await shopEligibility(member.id, 1000000);
    expect(res.ok).toBe(true);
  });

  it("blocks an order above 50% of total savings", async () => {
    const { member } = await seedMember({ totalSaved: 1000000 });
    const res = await shopEligibility(member.id, 600000);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/50%/);
  });

  it("blocks a frozen member", async () => {
    const { member } = await seedMember({ totalSaved: 5000000, frozenAt: new Date() });
    const res = await shopEligibility(member.id, 100000);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/frozen/i);
  });

  it("blocks a second open order", async () => {
    const { coop, member } = await seedMember({ totalSaved: 5000000 });
    const item = await seedItem(coop.id, member.id);
    await prisma.shopOrder.create({
      data: { ref: "shop-open1", cooperativeId: coop.id, memberId: member.id, itemId: item.id, cashPrice: 100000, months: 1, monthlyKobo: 100000, status: "pending" },
    });
    const res = await shopEligibility(member.id, 100000);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/in progress/i);
  });
});

describe("catalog and orders", () => {
  it("creates an item and rejects bad input", async () => {
    const { coop, member } = await seedMember();
    const ok = await createShopItem({
      cooperativeId: coop.id,
      createdById: member.id,
      actorPhone: PHONE,
      actorRole: "admin",
      name: "Gas Cylinder",
      cashPrice: 4500000,
      maxMonths: 6,
      stockQty: 5,
    });
    expect(ok.ok).toBe(true);
    expect(await prisma.shopItem.count()).toBe(1);

    const bad = await createShopItem({
      cooperativeId: coop.id,
      createdById: member.id,
      actorPhone: PHONE,
      actorRole: "admin",
      name: "Free thing",
      cashPrice: 0,
      maxMonths: 6,
      stockQty: null,
    });
    expect(bad.ok).toBe(false);
  });

  it("places a pending order with the right monthly amount", async () => {
    const { coop, member } = await seedMember({ totalSaved: 20000000 });
    const item = await seedItem(coop.id, member.id);
    const res = await createShopOrder({
      cooperativeId: coop.id,
      memberId: member.id,
      memberName: member.name,
      itemId: item.id,
      months: 3,
    });
    expect(res.ok).toBe(true);
    const order = await prisma.shopOrder.findFirst({ where: { memberId: member.id } });
    expect(order?.status).toBe("pending");
    expect(order?.monthlyKobo).toBe(2933333);
  });

  it("rejects months above the item maximum", async () => {
    const { coop, member } = await seedMember({ totalSaved: 20000000 });
    const item = await seedItem(coop.id, member.id, { maxMonths: 2 });
    const res = await createShopOrder({
      cooperativeId: coop.id,
      memberId: member.id,
      memberName: member.name,
      itemId: item.id,
      months: 3,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/between 1 and 2/);
  });

  it("rejects an out-of-stock item", async () => {
    const { coop, member } = await seedMember({ totalSaved: 20000000 });
    const item = await seedItem(coop.id, member.id, { stockQty: 0 });
    const res = await createShopOrder({
      cooperativeId: coop.id,
      memberId: member.id,
      memberName: member.name,
      itemId: item.id,
      months: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/out of stock/i);
  });
});

describe("approval and dispatch", () => {
  it("approves a pending order and notifies the member", async () => {
    const { coop, member } = await seedMember({ totalSaved: 20000000, role: "admin" });
    const item = await seedItem(coop.id, member.id);
    const created = await createShopOrder({ cooperativeId: coop.id, memberId: member.id, memberName: member.name, itemId: item.id, months: 3 });
    const res = await approveShopOrder({ cooperativeId: coop.id, key: created.ref!, actorId: member.id, actorPhone: PHONE, actorRole: "admin" });
    expect(res.ok).toBe(true);
    const order = await prisma.shopOrder.findUnique({ where: { id: created.orderId! } });
    expect(order?.status).toBe("approved");
    expect(vi.mocked(notifyMember).mock.calls.some((c) => String(c[1]).includes(created.ref!))).toBe(true);
  });

  it("rejects an order with a reason", async () => {
    const { coop, member } = await seedMember({ totalSaved: 20000000, role: "admin" });
    const item = await seedItem(coop.id, member.id);
    const created = await createShopOrder({ cooperativeId: coop.id, memberId: member.id, memberName: member.name, itemId: item.id, months: 1 });
    const res = await rejectShopOrder({ cooperativeId: coop.id, key: created.ref!, reason: "KYC pending", actorId: member.id, actorPhone: PHONE });
    expect(res.ok).toBe(true);
    const order = await prisma.shopOrder.findUnique({ where: { id: created.orderId! } });
    expect(order?.status).toBe("rejected");
    expect(order?.rejectReason).toBe("KYC pending");
  });

  it("refuses dispatch before approval", async () => {
    const { coop, member } = await seedMember({ totalSaved: 20000000 });
    const item = await seedItem(coop.id, member.id);
    const created = await createShopOrder({ cooperativeId: coop.id, memberId: member.id, memberName: member.name, itemId: item.id, months: 1 });
    const res = await dispatchShopOrder({ cooperativeId: coop.id, key: created.ref!, actorId: member.id, actorPhone: PHONE });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/must be approved/i);
  });

  it("dispatches, creates an interest-free shop loan, decrements stock and books the ledger", async () => {
    const { coop, member } = await seedMember({ totalSaved: 20000000 });
    const item = await seedItem(coop.id, member.id, { stockQty: 2 });
    const created = await createShopOrder({ cooperativeId: coop.id, memberId: member.id, memberName: member.name, itemId: item.id, months: 3 });
    await approveShopOrder({ cooperativeId: coop.id, key: created.ref!, actorId: member.id, actorPhone: PHONE });
    const res = await dispatchShopOrder({ cooperativeId: coop.id, key: created.ref!, actorId: member.id, actorPhone: PHONE });
    expect(res.ok).toBe(true);

    const order = await prisma.shopOrder.findUnique({ where: { id: created.orderId! } });
    expect(order?.status).toBe("dispatched");
    const loan = await prisma.loan.findUnique({ where: { id: order!.loanId! } });
    expect(loan?.kind).toBe("shop");
    expect(loan?.interestRate).toBe(0);
    expect(loan?.balance).toBe(8800000);
    expect(loan?.monthlyPayment).toBe(2933333);
    const fresh = await prisma.shopItem.findUnique({ where: { id: item.id } });
    expect(fresh?.stockQty).toBe(1);
    const ledger = await prisma.ledgerEntry.findFirst({ where: { reference: loan!.id } });
    expect(ledger?.category).toBe("assets:loan_portfolio");
  });
});

describe("member commands", () => {
  it("shop lists active items", async () => {
    const { coop, member } = await seedMember();
    await seedItem(coop.id, member.id, { name: "Gas Cylinder" });
    await handleMessage(PHONE, "shop");
    expect(lastText()).toContain("Gas Cylinder");
  });

  it("buyitem asks for the PIN and creates nothing yet", async () => {
    const { coop, member } = await seedMember({ totalSaved: 20000000 });
    await seedItem(coop.id, member.id);
    await handleMessage(PHONE, "buyitem 1 3");
    const prompts = vi.mocked(sendSecurePrompt).mock.calls;
    expect(String(prompts[prompts.length - 1]?.[0]?.text ?? "")).toMatch(/PIN/);
    expect(await prisma.shopOrder.count()).toBe(0);
  });

  it("a wrong PIN creates no order", async () => {
    const { coop, member } = await seedMember({ totalSaved: 20000000 });
    await seedItem(coop.id, member.id);
    await handleMessage(PHONE, "buyitem 1 3");
    await handleMessage(PHONE, "0000");
    expect(await prisma.shopOrder.count()).toBe(0);
  });

  it("the correct PIN creates a pending order", async () => {
    const { coop, member } = await seedMember({ totalSaved: 20000000 });
    await seedItem(coop.id, member.id);
    await handleMessage(PHONE, "buyitem 1 3");
    await handleMessage(PHONE, "1234");
    const order = await prisma.shopOrder.findFirst({ where: { memberId: member.id } });
    expect(order?.status, lastText()).toBe("pending");
  });

  it("refuses shop admin commands from a non-admin", async () => {
    await seedMember({ role: "member" });
    await handleMessage(PHONE, 'addshopitem "Gas Cylinder" 45000 6');
    expect(lastText()).toMatch(/Only a cooperative admin/i);
    expect(await prisma.shopItem.count()).toBe(0);
  });
});

describe("installment collection", () => {
  it("debits a full installment and rolls the due date one month", async () => {
    const { coop, member, wallet } = await seedMember({ totalSaved: 5000000 });
    await prisma.wallet.update({ where: { id: wallet.id }, data: { balance: 4000000 } });
    const loan = await seedShopLoan({
      coopId: coop.id,
      memberId: member.id,
      balance: 2933334,
      monthlyPayment: 2933334,
      dueDate: new Date(Date.now() - 86400000),
    });
    const processed = await runShopInstallments(new Date());
    expect(processed).toBe(1);
    const after = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(after?.balance).toBe(0);
    expect(after?.status).toBe("paid");
    const freshWallet = await prisma.wallet.findUnique({ where: { id: wallet.id } });
    expect(freshWallet?.balance).toBe(4000000 - 2933334);
  });

  it("debits what is available and retries in a week on shortfall", async () => {
    const { coop, member, wallet } = await seedMember({ totalSaved: 5000000 });
    await prisma.wallet.update({ where: { id: wallet.id }, data: { balance: 1000000 } });
    const dueDate = new Date(Date.now() - 86400000);
    const loan = await seedShopLoan({
      coopId: coop.id,
      memberId: member.id,
      balance: 2933334,
      monthlyPayment: 2933334,
      dueDate,
    });
    await runShopInstallments(new Date());
    const after = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(after?.balance).toBe(1933334);
    expect(after?.status).toBe("disbursed");
    const freshWallet = await prisma.wallet.findUnique({ where: { id: wallet.id } });
    expect(freshWallet?.balance).toBe(0);
    const next = after?.dueDate ?? new Date(0);
    const diffDays = Math.round((next.getTime() - dueDate.getTime()) / 86400000);
    expect(diffDays).toBe(7);
    expect(vi.mocked(notifyMember).mock.calls.some((c) => String(c[1]).includes("still due"))).toBe(true);
  });

  it("records arrears without debiting when the wallet is empty", async () => {
    const { coop, member, wallet } = await seedMember({ totalSaved: 0 });
    await prisma.wallet.update({ where: { id: wallet.id }, data: { balance: 0 } });
    const loan = await seedShopLoan({
      coopId: coop.id,
      memberId: member.id,
      balance: 2933334,
      monthlyPayment: 2933334,
      dueDate: new Date(Date.now() - 86400000),
    });
    await runShopInstallments(new Date());
    const after = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(after?.balance).toBe(2933334);
    expect(await prisma.loanRepayment.count()).toBe(0);
  });

  it("is idempotent within the same day", async () => {
    const { coop, member, wallet } = await seedMember({ totalSaved: 5000000 });
    await prisma.wallet.update({ where: { id: wallet.id }, data: { balance: 9000000 } });
    await seedShopLoan({
      coopId: coop.id,
      memberId: member.id,
      balance: 2933334,
      monthlyPayment: 2933334,
      dueDate: new Date(Date.now() - 86400000),
    });
    await runShopInstallments(new Date());
    await runShopInstallments(new Date());
    expect(await prisma.loanRepayment.count()).toBe(1);
    const freshWallet = await prisma.wallet.findUnique({ where: { id: wallet.id } });
    expect(freshWallet?.balance).toBe(9000000 - 2933334);
  });

  it("ignores loans that are not due yet", async () => {
    const { coop, member, wallet } = await seedMember({ totalSaved: 5000000 });
    await prisma.wallet.update({ where: { id: wallet.id }, data: { balance: 4000000 } });
    await seedShopLoan({
      coopId: coop.id,
      memberId: member.id,
      balance: 2933334,
      monthlyPayment: 2933334,
      dueDate: new Date(Date.now() + 86400000),
    });
    const processed = await runShopInstallments(new Date());
    expect(processed).toBe(0);
    const freshWallet = await prisma.wallet.findUnique({ where: { id: wallet.id } });
    expect(freshWallet?.balance).toBe(4000000);
  });
});
