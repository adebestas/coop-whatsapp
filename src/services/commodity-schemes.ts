import { prisma } from "../lib/prisma.js";
import { formatBalance, getMemberByPhone } from "./cooperative.js";
import { audit } from "./audit.js";
import { notifyMember } from "../lib/messaging.js";
import { getCreditPositionForMember } from "./commodity-credit.js";
import { installmentSchedule } from "./shop.js";

export interface SchemeResult {
  ok: boolean;
  message: string;
  id?: string;
  ref?: string;
}

export interface SchemeItemInput {
  name: string;
  unitLabel: string;
  unitCostKobo: number;
  memberPriceKobo: number;
  totalUnits: number | null;
  maxQtyPerMember: number;
}

const ACTIVE_SUB_STATUSES = ["reserved", "approved", "converted"];

function makeSchemeRef(): string {
  return `SCH-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

function makeSubscriptionRef(): string {
  return `CS-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

async function staffMember(phone: string, roles: string[]) {
  return prisma.member.findFirst({ where: { phone, role: { in: roles } } });
}

async function findScheme(cooperativeId: string, key: string) {
  return prisma.commodityScheme.findFirst({
    where: { cooperativeId, OR: [{ id: key }, { reference: key.toUpperCase() }] },
    include: { items: true },
  });
}

export async function createScheme(
  superPhone: string,
  input: { name: string; season?: string; opensAt: Date; closesAt: Date },
): Promise<SchemeResult> {
  const superM = await staffMember(superPhone, ["superadmin"]);
  if (!superM) return { ok: false, message: "Only a *super admin* can create a commodity scheme." };
  const name = input.name.trim();
  if (!name)
    return { ok: false, message: "Usage: *newscheme <name> | <season> | <opens> | <closes>*" };
  if (input.closesAt <= input.opensAt) {
    return { ok: false, message: "The closing date must be after the opening date." };
  }
  const scheme = await prisma.commodityScheme.create({
    data: {
      cooperativeId: superM.cooperativeId,
      reference: makeSchemeRef(),
      name,
      season: input.season?.trim() || null,
      opensAt: input.opensAt,
      closesAt: input.closesAt,
      createdById: superM.id,
    },
  });
  await audit({
    cooperativeId: superM.cooperativeId,
    actorPhone: superPhone,
    actorRole: "superadmin",
    action: "commodity.scheme.created",
    targetType: "commodityScheme",
    targetId: scheme.id,
    detail: `${scheme.reference}: ${name}`,
  });
  return {
    ok: true,
    id: scheme.id,
    ref: scheme.reference,
    message:
      `Scheme *${scheme.reference}* created for *${name}*.\n` +
      `Add items with *addschemeitem ${scheme.reference} | <name> | <unit> | <cost> | <price> | <units> | <max>*, then *openscheme ${scheme.reference}*.`,
  };
}

export async function addSchemeItem(
  superPhone: string,
  schemeRef: string,
  input: SchemeItemInput,
): Promise<SchemeResult> {
  const superM = await staffMember(superPhone, ["superadmin"]);
  if (!superM) return { ok: false, message: "Only a *super admin* can add scheme items." };
  const scheme = await findScheme(superM.cooperativeId, schemeRef);
  if (!scheme) return { ok: false, message: "Scheme not found." };
  if (scheme.status !== "draft") {
    return {
      ok: false,
      message: `Scheme ${scheme.reference} is ${scheme.status}; items can only be added while it is draft.`,
    };
  }
  if (!input.name.trim() || input.memberPriceKobo <= 0) {
    return { ok: false, message: "Item needs a name and a member price above zero." };
  }
  if (input.maxQtyPerMember < 1)
    return { ok: false, message: "Max per member must be at least 1." };
  const item = await prisma.commoditySchemeItem.create({
    data: {
      schemeId: scheme.id,
      name: input.name.trim(),
      unitLabel: input.unitLabel.trim() || "unit",
      unitCostKobo: Math.max(0, input.unitCostKobo),
      memberPriceKobo: input.memberPriceKobo,
      totalUnits: input.totalUnits,
      maxQtyPerMember: input.maxQtyPerMember,
    },
  });
  return {
    ok: true,
    id: scheme.id,
    ref: item.id,
    message: `Added *${item.name}* (${item.unitLabel}) at ${formatBalance(item.memberPriceKobo)} to *${scheme.reference}*.`,
  };
}

export async function openScheme(adminPhone: string, schemeRef: string): Promise<SchemeResult> {
  const admin = await staffMember(adminPhone, ["admin", "superadmin"]);
  if (!admin) return { ok: false, message: "Only an admin can open a scheme." };
  const scheme = await findScheme(admin.cooperativeId, schemeRef);
  if (!scheme) return { ok: false, message: "Scheme not found." };
  if (scheme.status !== "draft")
    return { ok: false, message: `Scheme ${scheme.reference} is ${scheme.status}.` };
  if (scheme.items.length === 0)
    return { ok: false, message: "Add at least one item before opening the scheme." };
  await prisma.commodityScheme.update({ where: { id: scheme.id }, data: { status: "open" } });
  await audit({
    cooperativeId: scheme.cooperativeId,
    actorPhone: adminPhone,
    actorRole: admin.role,
    action: "commodity.scheme.opened",
    targetType: "commodityScheme",
    targetId: scheme.id,
    detail: scheme.reference,
  });
  const members = await prisma.member.findMany({
    where: { cooperativeId: scheme.cooperativeId, status: "active" },
    select: {
      id: true,
      phone: true,
      name: true,
      altChannelId: true,
      preferredChannel: true,
      optedOut: true,
    },
  });
  for (const m of members) {
    const position = await getCreditPositionForMember(m.id, scheme.cooperativeId);
    if (position.availableKobo <= 0) continue;
    await notifyMember(
      m,
      `*${scheme.name}* is open.\n` +
        `Your commodity credit: *${formatBalance(position.availableKobo)}*.\n` +
        `Reply *schemes* to see items, then *subscribe ${scheme.reference} <item> <qty> [months]*.`,
    ).catch(() => {});
  }
  return {
    ok: true,
    message: `Scheme *${scheme.reference}* is now open. Eligible members were notified.`,
  };
}

export async function closeScheme(adminPhone: string, schemeRef: string): Promise<SchemeResult> {
  const admin = await staffMember(adminPhone, ["admin", "superadmin"]);
  if (!admin) return { ok: false, message: "Only an admin can close a scheme." };
  const scheme = await findScheme(admin.cooperativeId, schemeRef);
  if (!scheme) return { ok: false, message: "Scheme not found." };
  if (scheme.status !== "open")
    return { ok: false, message: `Scheme ${scheme.reference} is ${scheme.status}, not open.` };
  await prisma.commodityScheme.update({ where: { id: scheme.id }, data: { status: "closed" } });
  await audit({
    cooperativeId: scheme.cooperativeId,
    actorPhone: adminPhone,
    actorRole: admin.role,
    action: "commodity.scheme.closed",
    targetType: "commodityScheme",
    targetId: scheme.id,
    detail: scheme.reference,
  });
  return {
    ok: true,
    message: `Scheme *${scheme.reference}* is closed. Review subscriptions with *schemesubs ${scheme.reference}*.`,
  };
}

export async function subscribeCommodity(
  phone: string,
  schemeRef: string,
  itemKey: string,
  qty: number,
  months: number,
): Promise<SchemeResult> {
  const member = await getMemberByPhone(phone);
  if (!member) return { ok: false, message: "Join a cooperative first." };
  const scheme = await findScheme(member.cooperativeId, schemeRef);
  if (!scheme) return { ok: false, message: "Scheme not found." };
  if (scheme.status !== "open") {
    return {
      ok: false,
      message: `Scheme ${scheme.reference} is ${scheme.status === "closed" ? "closed" : scheme.status}; subscriptions are not open.`,
    };
  }
  const now = new Date();
  if (now < scheme.opensAt || now > scheme.closesAt) {
    return { ok: false, message: "The subscription window is not open right now." };
  }
  const item =
    scheme.items.find((i) => i.id === itemKey) ??
    scheme.items.find((i) => i.name.toLowerCase() === itemKey.toLowerCase()) ??
    scheme.items.find((i) => i.name.toLowerCase().includes(itemKey.toLowerCase()));
  if (!item) return { ok: false, message: "That item is not on this scheme." };
  const safeQty = Math.floor(qty);
  const safeMonths = Math.floor(months);
  if (!Number.isFinite(safeQty) || safeQty < 1)
    return { ok: false, message: "Quantity must be at least 1." };
  if (!Number.isFinite(safeMonths) || safeMonths < 3 || safeMonths > 6) {
    return { ok: false, message: "Choose 3 to 6 monthly installments." };
  }
  const already = await prisma.commoditySubscription.aggregate({
    where: {
      schemeId: scheme.id,
      itemId: item.id,
      memberId: member.id,
      status: { in: ACTIVE_SUB_STATUSES },
    },
    _sum: { qty: true },
  });
  const alreadyQty = already._sum.qty ?? 0;
  if (alreadyQty + safeQty > item.maxQtyPerMember) {
    return {
      ok: false,
      message: `The maximum per member for *${item.name}* is ${item.maxQtyPerMember}.`,
    };
  }
  if (alreadyQty > 0) {
    return { ok: false, message: "You already have a subscription for that item on this scheme." };
  }
  if (item.totalUnits !== null) {
    const taken = await prisma.commoditySubscription.aggregate({
      where: { itemId: item.id, status: { in: ACTIVE_SUB_STATUSES } },
      _sum: { qty: true },
    });
    const left = item.totalUnits - (taken._sum.qty ?? 0);
    if (safeQty > left)
      return { ok: false, message: `Only ${Math.max(0, left)} unit(s) of *${item.name}* left.` };
  }
  const totalKobo = item.memberPriceKobo * safeQty;
  const position = await getCreditPositionForMember(member.id, member.cooperativeId);
  if (position.availableKobo <= 0) {
    return {
      ok: false,
      message: `You have no commodity credit right now. ${position.blockedReason ?? ""}`.trim(),
    };
  }
  if (totalKobo > position.availableKobo) {
    return {
      ok: false,
      message:
        `That costs ${formatBalance(totalKobo)} but your available commodity credit is ` +
        `*${formatBalance(position.availableKobo)}*. Reduce the quantity or installments.`,
    };
  }
  const { monthly } = installmentSchedule(totalKobo, safeMonths);
  const sub = await prisma.commoditySubscription.create({
    data: {
      reference: makeSubscriptionRef(),
      cooperativeId: member.cooperativeId,
      schemeId: scheme.id,
      itemId: item.id,
      memberId: member.id,
      qty: safeQty,
      unitPriceKobo: item.memberPriceKobo,
      totalKobo,
      months: safeMonths,
    },
  });
  await audit({
    cooperativeId: member.cooperativeId,
    actorPhone: phone,
    actorRole: member.role,
    action: "commodity.subscription.created",
    targetType: "commoditySubscription",
    targetId: sub.id,
    amount: totalKobo,
    detail: `${sub.reference}: ${safeQty} x ${item.name} on ${scheme.reference}`,
  });
  await notifyMember(
    member,
    `*Reserved:* ${safeQty} x ${item.name}\n` +
      `Total: *${formatBalance(totalKobo)}* over ${safeMonths} months (~${formatBalance(monthly)}/month).\n` +
      `Reference: ${sub.reference}. Repayment starts after the co-op buys the goods.`,
  ).catch(() => {});
  return {
    ok: true,
    id: sub.id,
    ref: sub.reference,
    message:
      `Reserved *${safeQty} x ${item.name}* on *${scheme.name}*.\n` +
      `Total ${formatBalance(totalKobo)} - about ${formatBalance(monthly)}/month for ${safeMonths} months.\n` +
      `Reference: *${sub.reference}*. Reply *mysubs* to review it.`,
  };
}

export async function cancelCommoditySubscription(
  phone: string,
  ref: string,
): Promise<SchemeResult> {
  const member = await getMemberByPhone(phone);
  if (!member) return { ok: false, message: "Join a cooperative first." };
  const sub = await prisma.commoditySubscription.findFirst({
    where: {
      cooperativeId: member.cooperativeId,
      memberId: member.id,
      reference: ref.toUpperCase(),
    },
    include: { scheme: true, item: true },
  });
  if (!sub) return { ok: false, message: "Subscription not found." };
  if (sub.status !== "reserved")
    return { ok: false, message: `Subscription ${sub.reference} is ${sub.status}.` };
  if (sub.scheme.status !== "open") {
    return {
      ok: false,
      message: "The scheme is no longer open; ask an admin to reject the subscription.",
    };
  }
  await prisma.commoditySubscription.update({
    where: { id: sub.id },
    data: { status: "cancelled", decidedAt: new Date(), decidedById: member.id },
  });
  await audit({
    cooperativeId: member.cooperativeId,
    actorPhone: phone,
    actorRole: member.role,
    action: "commodity.subscription.cancelled",
    targetType: "commoditySubscription",
    targetId: sub.id,
    detail: sub.reference,
  });
  return {
    ok: true,
    message: `Subscription *${sub.reference}* cancelled; your credit is free again.`,
  };
}

export async function rejectCommoditySubscription(
  adminPhone: string,
  ref: string,
  reason?: string,
): Promise<SchemeResult> {
  const admin = await staffMember(adminPhone, ["admin", "superadmin"]);
  if (!admin) return { ok: false, message: "Only an admin can reject a subscription." };
  const sub = await prisma.commoditySubscription.findFirst({
    where: { cooperativeId: admin.cooperativeId, reference: ref.toUpperCase() },
    include: { member: true },
  });
  if (!sub) return { ok: false, message: "Subscription not found." };
  if (sub.status !== "reserved" && sub.status !== "approved") {
    return { ok: false, message: `Subscription ${sub.reference} is ${sub.status}.` };
  }
  await prisma.commoditySubscription.update({
    where: { id: sub.id },
    data: {
      status: "rejected",
      decidedAt: new Date(),
      decidedById: admin.id,
      rejectReason: reason?.trim() || null,
    },
  });
  await audit({
    cooperativeId: admin.cooperativeId,
    actorPhone: adminPhone,
    actorRole: admin.role,
    action: "commodity.subscription.rejected",
    targetType: "commoditySubscription",
    targetId: sub.id,
    detail: `${sub.reference}${reason ? `: ${reason}` : ""}`,
  });
  await notifyMember(
    sub.member,
    `Your subscription *${sub.reference}* was not approved${reason ? `: ${reason}` : "."}`,
  ).catch(() => {});
  return { ok: true, message: `Subscription *${sub.reference}* rejected; credit released.` };
}

export async function bankCashKobo(cooperativeId: string): Promise<number> {
  const rows = await prisma.posting.groupBy({
    by: ["direction"],
    where: { entry: { cooperativeId }, account: "assets:bank" },
    _sum: { amount: true },
  });
  const debit = rows.find((r) => r.direction === "DEBIT")?._sum.amount ?? 0;
  const credit = rows.find((r) => r.direction === "CREDIT")?._sum.amount ?? 0;
  return debit - credit;
}

export async function purchaseScheme(
  superPhone: string,
  ref: string,
  supplier: string,
  actualCostKobo: number,
  opts: { fundingSource?: "cash" | "supplier_credit"; note?: string } = {},
): Promise<SchemeResult> {
  const superM = await staffMember(superPhone, ["superadmin"]);
  if (!superM) return { ok: false, message: "Only a *super admin* can record a scheme purchase." };
  const scheme = await findScheme(superM.cooperativeId, ref);
  if (!scheme) return { ok: false, message: "Scheme not found." };
  if (scheme.status !== "closed") {
    return {
      ok: false,
      message: `Scheme ${scheme.reference} is ${scheme.status}; close it before purchasing.`,
    };
  }
  if (!Number.isFinite(actualCostKobo) || actualCostKobo <= 0) {
    return { ok: false, message: "Usage: *purchasescheme <ref> | <supplier> | <cost>*" };
  }
  const fundingSource = opts.fundingSource ?? "cash";
  if (fundingSource === "supplier_credit" && !opts.note?.trim()) {
    return { ok: false, message: "A supplier-credit purchase needs a note (payment terms)." };
  }
  if (fundingSource === "cash") {
    const cash = await bankCashKobo(scheme.cooperativeId);
    const alreadyCommitted = await prisma.commodityScheme.aggregate({
      where: {
        cooperativeId: scheme.cooperativeId,
        status: { in: ["purchased", "converted"] },
        id: { not: scheme.id },
      },
      _sum: { actualCostKobo: true },
    });
    const available = cash - (alreadyCommitted._sum.actualCostKobo ?? 0);
    if (available < actualCostKobo) {
      return {
        ok: false,
        message:
          `Reconciled bank cash is ${formatBalance(available)}; this purchase needs ${formatBalance(actualCostKobo)}.\n` +
          `Wait for remittances, or record supplier credit with *purchasescheme ${scheme.reference} | ${supplier} | ${actualCostKobo / 100} | supplier_credit | <terms>* (super admin only, audited).`,
      };
    }
  }
  await prisma.commodityScheme.update({
    where: { id: scheme.id },
    data: {
      status: "purchased",
      supplier: supplier.trim(),
      actualCostKobo,
      fundingSource,
      purchaseNote: opts.note?.trim() || null,
      purchasedAt: new Date(),
      purchasedById: superM.id,
    },
  });
  await audit({
    cooperativeId: scheme.cooperativeId,
    actorPhone: superPhone,
    actorRole: "superadmin",
    action: "commodity.scheme.purchased",
    targetType: "commodityScheme",
    targetId: scheme.id,
    amount: actualCostKobo,
    detail: `${scheme.reference}: ${supplier} via ${fundingSource}${opts.note ? ` (${opts.note})` : ""}`,
  });
  return {
    ok: true,
    message:
      `Purchase recorded for *${scheme.reference}*: ${formatBalance(actualCostKobo)} from ${supplier} (${fundingSource}).\n` +
      `Run *convertscheme ${scheme.reference}* to turn reservations into payroll installments.`,
  };
}

export async function convertScheme(superPhone: string, ref: string): Promise<SchemeResult> {
  const superM = await staffMember(superPhone, ["superadmin"]);
  if (!superM) return { ok: false, message: "Only a *super admin* can convert a scheme." };
  const scheme = await findScheme(superM.cooperativeId, ref);
  if (!scheme) return { ok: false, message: "Scheme not found." };
  if (scheme.status !== "purchased") {
    return {
      ok: false,
      message: `Scheme ${scheme.reference} is ${scheme.status}; purchase it first.`,
    };
  }
  const subs = await prisma.commoditySubscription.findMany({
    where: { schemeId: scheme.id, status: { in: ["reserved", "approved"] } },
    include: { item: true, member: true },
    orderBy: { createdAt: "asc" },
  });
  if (subs.length === 0) return { ok: false, message: "No subscriptions to convert." };

  const period = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
  let batch = await prisma.deductionBatch.findFirst({
    where: { cooperativeId: scheme.cooperativeId, status: { in: ["draft", "submitted"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!batch) {
    batch = await prisma.deductionBatch.create({
      data: {
        cooperativeId: scheme.cooperativeId,
        ref: `DED-${period}-${Date.now().toString(36).toUpperCase()}`,
        note: `Commodity scheme ${scheme.reference}`,
        totalAmount: 0,
        createdById: superM.id,
      },
    });
  }

  let created = 0;
  let addedTotal = 0;
  for (const sub of subs) {
    const { monthly } = installmentSchedule(sub.totalKobo, sub.months);
    const loan = await prisma.loan.create({
      data: {
        cooperativeId: scheme.cooperativeId,
        memberId: sub.memberId,
        amount: sub.totalKobo,
        balance: sub.totalKobo,
        tenureMonths: sub.months,
        monthlyPayment: monthly,
        status: "disbursed",
        kind: "commodity",
      },
    });
    const firstInstallment = Math.min(monthly, loan.balance);
    const existingItem = await prisma.deductionItem.findFirst({
      where: { batchId: batch.id, memberId: sub.memberId, kind: "commodity" },
    });
    if (existingItem) {
      await prisma.deductionItem.update({
        where: { id: existingItem.id },
        data: { amount: existingItem.amount + firstInstallment },
      });
    } else {
      await prisma.deductionItem.create({
        data: {
          batchId: batch.id,
          memberId: sub.memberId,
          kind: "commodity",
          loanId: loan.id,
          amount: firstInstallment,
        },
      });
    }
    addedTotal += firstInstallment;
    await prisma.commoditySubscription.update({
      where: { id: sub.id },
      data: {
        status: "converted",
        convertedLoanId: loan.id,
        decidedAt: new Date(),
        decidedById: superM.id,
      },
    });
    await notifyMember(
      sub.member,
      `*${sub.qty} x ${sub.item.name}* is now financed.\n` +
        `${sub.months} payroll installments of about ${formatBalance(monthly)}, starting with batch *${batch.ref}*.`,
    ).catch(() => {});
    created += 1;
  }
  if (addedTotal > 0) {
    await prisma.deductionBatch.update({
      where: { id: batch.id },
      data: { totalAmount: { increment: addedTotal } },
    });
  }
  await prisma.commodityScheme.update({
    where: { id: scheme.id },
    data: { status: "converted", convertedAt: new Date() },
  });
  await audit({
    cooperativeId: scheme.cooperativeId,
    actorPhone: superPhone,
    actorRole: "superadmin",
    action: "commodity.scheme.converted",
    targetType: "commodityScheme",
    targetId: scheme.id,
    detail: `${scheme.reference}: ${created} subscription(s)`,
  });
  return {
    ok: true,
    message:
      `Converted *${created}* subscription(s) on *${scheme.reference}*.\n` +
      `First installments were added to batch *${batch.ref}*.`,
  };
}

async function findSubscription(cooperativeId: string, ref: string) {
  return prisma.commoditySubscription.findFirst({
    where: { cooperativeId, OR: [{ id: ref }, { reference: ref.toUpperCase() }] },
    include: { member: { select: { id: true, name: true, code: true } }, item: true, scheme: true },
  });
}

export async function dispatchCommodity(adminPhone: string, ref: string): Promise<SchemeResult> {
  const admin = await staffMember(adminPhone, ["admin", "superadmin"]);
  if (!admin) return { ok: false, message: "Only an admin can mark a subscription dispatched." };
  const sub = await findSubscription(admin.cooperativeId, ref);
  if (!sub) return { ok: false, message: "Subscription not found." };
  if (sub.status !== "converted")
    return { ok: false, message: `Subscription ${sub.reference} is ${sub.status}.` };
  if (sub.dispatchedAt)
    return { ok: false, message: `Subscription ${sub.reference} was already dispatched.` };
  await prisma.commoditySubscription.update({
    where: { id: sub.id },
    data: { dispatchedAt: new Date() },
  });
  await audit({
    cooperativeId: admin.cooperativeId,
    actorPhone: adminPhone,
    actorRole: admin.role,
    action: "commodity.subscription.dispatched",
    targetType: "commoditySubscription",
    targetId: sub.id,
    detail: sub.reference,
  });
  await notifyMember(
    sub.member,
    `Your *${sub.qty} x ${sub.item.name}* is ready for collection.\n` +
      `Admin will mark it collected with *collectsub ${sub.reference} <your code>*.`,
  ).catch(() => {});
  return { ok: true, message: `Subscription *${sub.reference}* marked dispatched.` };
}

export async function collectCommodity(
  adminPhone: string,
  ref: string,
  memberCode: string,
): Promise<SchemeResult> {
  const admin = await staffMember(adminPhone, ["admin", "superadmin"]);
  if (!admin) return { ok: false, message: "Only an admin can mark a subscription collected." };
  const sub = await findSubscription(admin.cooperativeId, ref);
  if (!sub) return { ok: false, message: "Subscription not found." };
  if (sub.status !== "converted" || !sub.dispatchedAt) {
    return { ok: false, message: "Dispatch the item before marking it collected." };
  }
  if (sub.collectedAt)
    return { ok: false, message: `Subscription ${sub.reference} was already collected.` };
  if (sub.member.code.toUpperCase() !== memberCode.trim().toUpperCase()) {
    return { ok: false, message: "That member code does not match the subscription." };
  }
  await prisma.commoditySubscription.update({
    where: { id: sub.id },
    data: { collectedAt: new Date(), collectedById: admin.id },
  });
  await audit({
    cooperativeId: admin.cooperativeId,
    actorPhone: adminPhone,
    actorRole: admin.role,
    action: "commodity.subscription.collected",
    targetType: "commoditySubscription",
    targetId: sub.id,
    detail: `${sub.reference} collected by ${sub.member.name}`,
  });
  return {
    ok: true,
    message: `Collected: *${sub.qty} x ${sub.item.name}* handed to ${sub.member.name}.`,
  };
}

export async function listSchemeSubscriptions(cooperativeId: string, ref: string) {
  const scheme = await findScheme(cooperativeId, ref);
  if (!scheme) return null;
  const subs = await prisma.commoditySubscription.findMany({
    where: { schemeId: scheme.id },
    include: { member: { select: { name: true, code: true } }, item: true },
    orderBy: { createdAt: "asc" },
  });
  return { scheme, subs };
}

export async function listMemberSubscriptions(memberId: string, cooperativeId: string) {
  return prisma.commoditySubscription.findMany({
    where: { memberId, cooperativeId, status: { not: "cancelled" } },
    include: { item: true, scheme: true },
    orderBy: { createdAt: "desc" },
  });
}
