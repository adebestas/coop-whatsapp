import { prisma, withTx } from "../lib/prisma.js";
import { formatBalance } from "../lib/money.js";
import { isFrozen } from "../lib/freeze.js";
import { notifyMember } from "../lib/messaging.js";
import { recordLedger } from "./ledger.js";
import { audit } from "./audit.js";

export const SHOP_MAX_MONTHS = 12;

export type ShopResult = { ok: boolean; message: string; orderId?: string; ref?: string };

export function installmentSchedule(
  priceKobo: number,
  months: number,
): { monthly: number; last: number } {
  const safeMonths = Math.max(1, Math.floor(months));
  const monthly = Math.floor(priceKobo / safeMonths);
  return { monthly, last: priceKobo - monthly * (safeMonths - 1) };
}

export function makeShopRef(): string {
  return `shop-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function shopEligibility(
  memberId: string,
  priceKobo: number,
): Promise<{ ok: boolean; message: string }> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      status: true,
      wallet: { select: { totalSaved: true } },
      shopOrders: {
        where: { status: { in: ["pending", "approved", "dispatched"] } },
        select: { id: true },
      },
    },
  });
  if (!member) return { ok: false, message: "You need to join a cooperative first." };
  if (member.status !== "active") {
    return { ok: false, message: "Your account is not active, so you cannot place a shop order." };
  }
  const frozen = await isFrozen(memberId);
  if (frozen.frozen) return { ok: false, message: frozen.message };
  if (member.shopOrders.length > 0) {
    return {
      ok: false,
      message: "You already have a shop order in progress. Finish it before ordering again.",
    };
  }
  const overdue = await prisma.loan.findFirst({
    where: {
      memberId,
      kind: "shop",
      status: "disbursed",
      balance: { gt: 0 },
      dueDate: { lt: new Date() },
    },
    select: { id: true },
  });
  if (overdue) {
    return { ok: false, message: "You have shop arrears. Clear them before placing a new order." };
  }
  const cap = Math.floor((member.wallet?.totalSaved ?? 0) / 2);
  if (priceKobo > cap) {
    return {
      ok: false,
      message: `That item is above your shop limit of ${formatBalance(cap)} (50% of your total savings).`,
    };
  }
  return { ok: true, message: "ok" };
}

export async function createShopItem(input: {
  cooperativeId: string;
  createdById: string;
  actorPhone: string;
  actorRole?: string;
  name: string;
  cashPrice: number;
  maxMonths: number;
  stockQty: number | null;
}): Promise<ShopResult> {
  const name = input.name.trim();
  if (name.length < 2) return { ok: false, message: "Give the item a name." };
  if (!Number.isFinite(input.cashPrice) || input.cashPrice <= 0) {
    return { ok: false, message: "Price must be greater than zero." };
  }
  const maxMonths = Math.floor(input.maxMonths);
  if (!Number.isFinite(maxMonths) || maxMonths < 1 || maxMonths > SHOP_MAX_MONTHS) {
    return { ok: false, message: `Repayment months must be between 1 and ${SHOP_MAX_MONTHS}.` };
  }
  if (input.stockQty !== null && (!Number.isFinite(input.stockQty) || input.stockQty < 0)) {
    return { ok: false, message: "Stock must be zero or more (omit it for unlimited)." };
  }
  const item = await prisma.shopItem.create({
    data: {
      cooperativeId: input.cooperativeId,
      createdById: input.createdById,
      name,
      cashPrice: input.cashPrice,
      maxMonths,
      stockQty: input.stockQty,
    },
  });
  await audit({
    cooperativeId: input.cooperativeId,
    actorPhone: input.actorPhone,
    actorId: input.createdById,
    actorRole: input.actorRole,
    action: "shop.item.create",
    detail: `Added shop item ${name} at ${formatBalance(input.cashPrice)}`,
  });
  return {
    ok: true,
    message: `Added *${name}* at ${formatBalance(input.cashPrice)}.`,
    ref: item.id,
  };
}

export async function createShopOrder(input: {
  cooperativeId: string;
  memberId: string;
  memberName: string;
  itemId: string;
  months: number;
}): Promise<ShopResult> {
  const item = await prisma.shopItem.findFirst({
    where: { id: input.itemId, cooperativeId: input.cooperativeId, active: true },
  });
  if (!item) return { ok: false, message: "That item is no longer available." };
  if (item.stockQty !== null && item.stockQty <= 0) {
    return { ok: false, message: "That item is out of stock." };
  }
  const months = Math.floor(input.months);
  if (!Number.isFinite(months) || months < 1 || months > item.maxMonths) {
    return {
      ok: false,
      message: `Choose a repayment plan between 1 and ${item.maxMonths} months.`,
    };
  }
  const eligible = await shopEligibility(input.memberId, item.cashPrice);
  if (!eligible.ok) return { ok: false, message: eligible.message };

  const { monthly } = installmentSchedule(item.cashPrice, months);
  const order = await prisma.shopOrder.create({
    data: {
      ref: makeShopRef(),
      cooperativeId: input.cooperativeId,
      memberId: input.memberId,
      itemId: item.id,
      cashPrice: item.cashPrice,
      months,
      monthlyKobo: monthly,
      status: "pending",
    },
  });
  return {
    ok: true,
    message:
      `Order ${order.ref} placed for *${item.name}*.\n` +
      `Price: ${formatBalance(item.cashPrice)} over ${months} month${months === 1 ? "" : "s"} ` +
      `- about ${formatBalance(monthly)}/month, interest-free.\n\n` +
      `Your cooperative will review it. Reply *myshop* to check the status.`,
    orderId: order.id,
    ref: order.ref,
  };
}

async function findOrder(cooperativeId: string, key: string) {
  return prisma.shopOrder.findFirst({
    where: { cooperativeId, OR: [{ id: key }, { ref: key.toLowerCase() }] },
    include: { item: true, member: { select: { id: true, name: true, phone: true } } },
  });
}

export async function approveShopOrder(input: {
  cooperativeId: string;
  key: string;
  actorId: string;
  actorPhone: string;
  actorRole?: string;
}): Promise<ShopResult> {
  const order = await findOrder(input.cooperativeId, input.key);
  if (!order) return { ok: false, message: "Order not found." };
  if (order.status !== "pending") {
    return { ok: false, message: `Order ${order.ref} is already ${order.status}.` };
  }
  await prisma.shopOrder.update({
    where: { id: order.id },
    data: { status: "approved", approvedAt: new Date(), approvedById: input.actorId },
  });
  await audit({
    cooperativeId: input.cooperativeId,
    actorPhone: input.actorPhone,
    actorId: input.actorId,
    actorRole: input.actorRole,
    action: "shop.order.approve",
    detail: `Approved ${order.ref} for ${order.member.name}`,
  });
  await notifyMember(
    order.member,
    `Your shop order ${order.ref} for *${order.item.name}* was approved.\n` +
      `It will be dispatched shortly. Reply *myshop* to track it.`,
  );
  return { ok: true, message: `Approved ${order.ref} (${order.member.name}).`, ref: order.ref };
}

export async function rejectShopOrder(input: {
  cooperativeId: string;
  key: string;
  reason: string;
  actorId: string;
  actorPhone: string;
  actorRole?: string;
}): Promise<ShopResult> {
  const order = await findOrder(input.cooperativeId, input.key);
  if (!order) return { ok: false, message: "Order not found." };
  if (order.status !== "pending") {
    return { ok: false, message: `Order ${order.ref} is already ${order.status}.` };
  }
  await prisma.shopOrder.update({
    where: { id: order.id },
    data: { status: "rejected", rejectReason: input.reason || "No reason given" },
  });
  await audit({
    cooperativeId: input.cooperativeId,
    actorPhone: input.actorPhone,
    actorId: input.actorId,
    actorRole: input.actorRole,
    action: "shop.order.reject",
    detail: `Rejected ${order.ref}: ${input.reason || "no reason"}`,
  });
  await notifyMember(
    order.member,
    `Your shop order ${order.ref} for *${order.item.name}* was declined.\n` +
      `Reason: ${input.reason || "not stated"}.\n\nReply *menu* for other options.`,
  );
  return { ok: true, message: `Rejected ${order.ref}.`, ref: order.ref };
}

export async function dispatchShopOrder(input: {
  cooperativeId: string;
  key: string;
  actorId: string;
  actorPhone: string;
  actorRole?: string;
}): Promise<ShopResult> {
  const order = await findOrder(input.cooperativeId, input.key);
  if (!order) return { ok: false, message: "Order not found." };
  if (order.status !== "approved") {
    return {
      ok: false,
      message: `Order ${order.ref} must be approved before dispatch (now ${order.status}).`,
    };
  }

  const result = await withTx(async (tx) => {
    if (order.item.stockQty !== null) {
      const dec = await tx.shopItem.updateMany({
        where: { id: order.itemId, stockQty: { gt: 0 } },
        data: { stockQty: { decrement: 1 } },
      });
      if (dec.count === 0)
        return { ok: false as const, message: `*${order.item.name}* is out of stock.` };
    }
    const { monthly } = installmentSchedule(order.cashPrice, order.months);
    const dueDate = new Date();
    dueDate.setMonth(dueDate.getMonth() + 1);
    const loan = await tx.loan.create({
      data: {
        amount: order.cashPrice,
        balance: order.cashPrice,
        interestRate: 0,
        tenureMonths: order.months,
        status: "disbursed",
        kind: "shop",
        monthlyPayment: monthly,
        adminCharge: 0,
        disbursementAmount: order.cashPrice,
        disbursedAt: new Date(),
        dueDate,
        memberId: order.memberId,
        cooperativeId: input.cooperativeId,
      },
    });
    await tx.shopOrder.update({
      where: { id: order.id },
      data: {
        status: "dispatched",
        dispatchedAt: new Date(),
        dispatchedById: input.actorId,
        loanId: loan.id,
        monthlyKobo: monthly,
      },
    });
    await recordLedger({
      cooperativeId: input.cooperativeId,
      type: "balance_sheet",
      category: "assets:loan_portfolio",
      amount: order.cashPrice,
      note: `Shop dispatch ${order.ref}: ${order.item.name} to ${order.member.name}`,
      reference: loan.id,
      fundType: "member",
      counterAccount: "assets:inventory",
      txRef: `shop-dispatch:${order.id}`,
      tx,
    });
    return { ok: true as const, message: "", loanId: loan.id };
  });

  if (!result.ok) return { ok: false, message: result.message };

  await audit({
    cooperativeId: input.cooperativeId,
    actorPhone: input.actorPhone,
    actorId: input.actorId,
    actorRole: input.actorRole,
    action: "shop.order.dispatch",
    detail: `Dispatched ${order.ref} for ${order.member.name}`,
  });
  await notifyMember(
    order.member,
    `*${order.item.name}* has been dispatched to you.\n` +
      `Plan: ${formatBalance(order.cashPrice)} over ${order.months} month${order.months === 1 ? "" : "s"} ` +
      `(${formatBalance(order.monthlyKobo)}/month).\n` +
      `Each installment is collected automatically from your savings on the due date; ` +
      `anything short is deducted from your next payroll.\n\nReply *myshop* to see the schedule.`,
  );
  return { ok: true, message: `Dispatched ${order.ref} (${order.member.name}).`, ref: order.ref };
}

export async function closeShopItem(input: {
  cooperativeId: string;
  key: string;
  actorId: string;
  actorPhone: string;
  actorRole?: string;
}): Promise<ShopResult> {
  const key = input.key.trim().toLowerCase();
  const items = await prisma.shopItem.findMany({
    where: { cooperativeId: input.cooperativeId, active: true },
  });
  const item = items.find((row) => row.id === input.key || row.name.toLowerCase() === key);
  if (!item) return { ok: false, message: "Item not found." };
  await prisma.shopItem.update({ where: { id: item.id }, data: { active: false } });
  await audit({
    cooperativeId: input.cooperativeId,
    actorPhone: input.actorPhone,
    actorId: input.actorId,
    actorRole: input.actorRole,
    action: "shop.item.close",
    detail: `Closed shop item ${item.name}`,
  });
  return { ok: true, message: `Removed *${item.name}* from the shop.` };
}

export async function catalogText(cooperativeId: string): Promise<string> {
  const items = await prisma.shopItem.findMany({
    where: { cooperativeId, active: true },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  if (items.length === 0) return "The shop has no items yet. Ask your admin to add some.";
  const lines = items.map((item, i) => {
    const stock = item.stockQty === null ? "unlimited" : `${item.stockQty} left`;
    return `${i + 1}. *${item.name}* - ${formatBalance(item.cashPrice)} (up to ${item.maxMonths} months, ${stock})`;
  });
  return `*Coop Shop* (interest-free)\n${lines.join("\n")}\n\nReply *buyitem <number> <months>* to order.`;
}

export async function memberOrdersText(memberId: string): Promise<string> {
  const orders = await prisma.shopOrder.findMany({
    where: { memberId },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      item: { select: { name: true } },
      loan: { select: { balance: true, dueDate: true } },
    },
  });
  if (orders.length === 0) return "You have no shop orders yet. Reply *shop* to browse.";
  const lines = orders.map((order) => {
    const plan = `${formatBalance(order.cashPrice)} over ${order.months}mo`;
    if (order.status === "dispatched" && order.loan) {
      const due = order.loan.dueDate ? order.loan.dueDate.toDateString() : "n/a";
      return `- ${order.ref}: *${order.item.name}* ${plan} - balance ${formatBalance(order.loan.balance)}, next due ${due}`;
    }
    if (order.status === "rejected") {
      return `- ${order.ref}: *${order.item.name}* - declined (${order.rejectReason ?? "no reason"})`;
    }
    return `- ${order.ref}: *${order.item.name}* ${plan} - ${order.status}`;
  });
  return `*Your shop orders*\n${lines.join("\n")}`;
}

export async function openOrdersText(cooperativeId: string, status = "pending"): Promise<string> {
  const orders = await prisma.shopOrder.findMany({
    where: { cooperativeId, status },
    orderBy: { createdAt: "asc" },
    take: 20,
    include: { item: { select: { name: true } }, member: { select: { name: true } } },
  });
  if (orders.length === 0) return `No ${status} shop orders.`;
  const lines = orders.map(
    (order) =>
      `- ${order.ref}: ${order.member.name} - ${order.item.name} ${formatBalance(order.cashPrice)}/${order.months}mo`,
  );
  return `*Shop orders (${status})*\n${lines.join("\n")}`;
}

export async function runShopInstallments(now: Date = new Date()): Promise<number> {
  const due = await prisma.loan.findMany({
    where: {
      kind: "shop",
      status: "disbursed",
      balance: { gt: 0 },
      dueDate: { lte: now },
    },
    include: {
      member: {
        select: {
          id: true,
          name: true,
          phone: true,
          altChannelId: true,
          preferredChannel: true,
          optedOut: true,
        },
      },
      shopOrder: { select: { ref: true } },
    },
  });

  let processed = 0;
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  for (const loan of due) {
    const already = await prisma.loanRepayment.findFirst({
      where: { loanId: loan.id, paidAt: { gte: startOfDay } },
      select: { id: true },
    });
    if (already) continue;

    const wallet = await prisma.wallet.findUnique({
      where: { memberId: loan.memberId },
      select: { id: true, balance: true },
    });
    if (!wallet) continue;

    const dueAmount = Math.min(loan.monthlyPayment ?? loan.balance, loan.balance);
    const applied = Math.min(dueAmount, wallet.balance);

    if (applied > 0) {
      await withTx(async (tx) => {
        const debited = await tx.wallet.updateMany({
          where: { id: wallet.id, balance: { gte: applied } },
          data: { balance: { decrement: applied } },
        });
        if (debited.count === 0) return;
        await tx.loanRepayment.create({ data: { loanId: loan.id, amount: applied } });
        await tx.loan.update({ where: { id: loan.id }, data: { balance: { decrement: applied } } });
        await recordLedger({
          cooperativeId: loan.cooperativeId,
          type: "balance_sheet",
          category: "assets:loan_portfolio",
          amount: applied,
          note: `Shop installment by ${loan.member.name}: ${formatBalance(applied)} on ${loan.shopOrder?.ref ?? loan.id.slice(-6)}`,
          reference: loan.id,
          fundType: "member",
          counterAccount: `member_wallet:${wallet.id}`,
          tx,
        });
      });
    }

    const updated = await prisma.loan.findUnique({
      where: { id: loan.id },
      select: { balance: true },
    });
    const remaining = updated?.balance ?? 0;

    if (remaining <= 0) {
      await prisma.loan.update({ where: { id: loan.id }, data: { status: "paid" } });
      await prisma.shopOrder.updateMany({
        where: { loanId: loan.id },
        data: { status: "completed" },
      });
      await notifyMember(
        loan.member,
        `Your shop plan ${loan.shopOrder?.ref ?? ""} is fully paid. Thank you!`
          .replace(/\s+/g, " ")
          .trim(),
      );
    } else {
      const next = new Date(loan.dueDate ?? now);
      if (applied >= dueAmount) next.setMonth(next.getMonth() + 1);
      else next.setDate(next.getDate() + 7);
      await prisma.loan.update({ where: { id: loan.id }, data: { dueDate: next } });
      if (applied < dueAmount) {
        const shortfall = dueAmount - applied;
        await notifyMember(
          loan.member,
          `We collected ${formatBalance(applied)} of your ${formatBalance(dueAmount)} shop installment ` +
            `(${formatBalance(shortfall)} still due). Please top up your savings; we retry in a week and ` +
            `will also deduct the balance from your next payroll.`,
        );
      }
    }
    processed++;
  }
  return processed;
}
