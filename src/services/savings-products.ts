import { prisma, withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import { postJournal } from "./journal.js";
import { audit } from "./audit.js";
import { notifyMember } from "../lib/messaging.js";
import { formatBalance } from "../lib/money.js";
import { roundMoney } from "./money.js";
import type { Prisma } from "@prisma/client";

export type SavingsProductType = "fixed" | "goal" | "seasonal" | "junior";

export interface SavingsActor {
  id: string;
  phone: string;
  role?: string | null;
}

export interface CreateProductOptions {
  interestRate?: number;
  termMonths?: number | null;
  minAmount?: number;
}

export interface ProductSummary {
  id: string;
  type: string;
  name: string;
  interestRate: number;
  termMonths: number | null;
  minAmount: number;
  active: boolean;
}

export interface MemberProductSummary {
  id: string;
  productId: string;
  productName: string;
  type: string;
  balance: number;
  targetAmount: number | null;
  status: string;
  maturesAt: Date | null;
  progress: ProductProgress;
}

export interface ProductProgress {
  balance: number;
  target: number | null;
  percent: number | null;
  complete: boolean;
}

export interface MemberProductAccount {
  balance: number;
  targetAmount: number | null;
}

const PRODUCT_TYPES = new Set<SavingsProductType>(["fixed", "goal", "seasonal", "junior"]);

/** A member's savings account is a liability of the cooperative. */
function productLiability(accountId: string): string {
  return `liability:savings_product:${accountId}`;
}

/** Resolve a product by full id or a leading/trailing id suffix, scoped to a coop. */
async function resolveProduct(
  coopId: string,
  idOrSuffix: string,
  client: Prisma.TransactionClient | typeof prisma = prisma as never,
) {
  if (!idOrSuffix) return null;
  return client.savingsProduct.findFirst({
    where: {
      cooperativeId: coopId,
      OR: [
        { id: idOrSuffix },
        { id: { startsWith: idOrSuffix } },
        { id: { endsWith: idOrSuffix } },
      ],
    },
  });
}

function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d;
}

/**
 * Progress of a savings account against its (optional) goal target.
 * `percent` is capped at 100 so an over-funded goal still reports 100%.
 */
export function productProgress(account: MemberProductAccount): ProductProgress {
  const balance = account.balance ?? 0;
  const target = account.targetAmount ?? null;
  const hasTarget = target !== null && target > 0;
  return {
    balance,
    target,
    percent: hasTarget ? Math.min(100, Math.floor((balance / target) * 100)) : null,
    complete: hasTarget && balance >= target,
  };
}

function productMeta(p: { interestRate: number; termMonths: number | null; minAmount: number }) {
  const parts: string[] = [];
  if (p.termMonths) parts.push(`${p.termMonths} month(s)`);
  if (p.interestRate) parts.push(`${p.interestRate}% at maturity`);
  if (p.minAmount) parts.push(`min ${formatBalance(p.minAmount)}`);
  return parts.length ? parts.join(", ") : "open-ended";
}

/** Create a savings product for a cooperative. `actor` is the acting admin. */
export async function createProduct(
  coopId: string,
  type: string,
  name: string,
  opts: CreateProductOptions,
  actor: SavingsActor,
): Promise<{ ok: boolean; message: string; productId?: string }> {
  const normalizedType = type.trim().toLowerCase() as SavingsProductType;
  if (!PRODUCT_TYPES.has(normalizedType)) {
    return { ok: false, message: "Product type must be *fixed*, *goal*, *seasonal* or *junior*." };
  }
  const productName = name.trim();
  if (!productName) return { ok: false, message: "Give the product a name." };

  const interestRate = roundMoney(opts.interestRate ?? 0);
  const minAmount = roundMoney(opts.minAmount ?? 0);
  const termMonths = opts.termMonths ?? null;
  if (interestRate < 0 || minAmount < 0) {
    return { ok: false, message: "Interest rate and minimum amount cannot be negative." };
  }
  if (termMonths !== null && (!Number.isInteger(termMonths) || termMonths <= 0)) {
    return { ok: false, message: "Term must be a whole number of months." };
  }

  const existing = await prisma.savingsProduct.findUnique({
    where: {
      cooperativeId_type_name: { cooperativeId: coopId, type: normalizedType, name: productName },
    },
  });
  if (existing) {
    return { ok: false, message: `A ${normalizedType} product named *${productName}* already exists.` };
  }

  const product = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    return tx.savingsProduct.create({
      data: {
        cooperativeId: coopId,
        type: normalizedType,
        name: productName,
        interestRate,
        termMonths,
        minAmount,
        createdById: actor.id,
      },
    });
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role ?? null,
    action: "savings.product_create",
    targetType: "savings_product",
    targetId: product.id,
    detail: `${normalizedType.toUpperCase()} ${productName} (${productMeta({ interestRate, termMonths, minAmount })})`,
  }).catch(() => {});

  return {
    ok: true,
    message:
      `✅ Created ${normalizedType.toUpperCase()} savings product *${productName}*.\n\n` +
      `• ${productMeta({ interestRate, termMonths, minAmount })}\n` +
      `• Product ID: *${product.id}*`,
    productId: product.id,
  };
}

/** List a cooperative's savings products. */
export async function listProducts(
  coopId: string,
): Promise<{ ok: boolean; message: string; products?: ProductSummary[] }> {
  const rows = await prisma.savingsProduct.findMany({
    where: { cooperativeId: coopId },
    orderBy: { createdAt: "desc" },
  });
  const products = rows.map((p) => ({
    id: p.id,
    type: p.type,
    name: p.name,
    interestRate: p.interestRate,
    termMonths: p.termMonths,
    minAmount: p.minAmount,
    active: p.active,
  }));
  return {
    ok: true,
    message: products.length ? `${products.length} savings product(s).` : "No savings products yet.",
    products,
  };
}

/**
 * Open a member's savings account against a product. Goal products require a
 * positive target; term products get a maturity date `termMonths` from now.
 */
export async function openProduct(
  coopId: string,
  productId: string,
  memberId: string,
  target?: number,
): Promise<{ ok: boolean; message: string; accountId?: string }> {
  const product = await resolveProduct(coopId, productId);
  if (!product) return { ok: false, message: "Savings product not found." };
  if (!product.active) return { ok: false, message: `The product *${product.name}* is closed.` };

  let targetAmount: number | null = null;
  if (product.type === "goal") {
    if (!Number.isInteger(target) || (target as number) <= 0) {
      return { ok: false, message: "A goal savings product needs a target amount, e.g. *openproduct <id> 50000*." };
    }
    targetAmount = roundMoney(target as number);
  } else if (Number.isInteger(target) && (target as number) > 0) {
    targetAmount = roundMoney(target as number);
  }

  const maturesAt = product.termMonths ? addMonths(new Date(), product.termMonths) : null;

  const account = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    return tx.savingsAccount.create({
      data: {
        cooperativeId: coopId,
        memberId,
        productId: product.id,
        balance: 0,
        targetAmount,
        status: "active",
        maturesAt,
      },
    });
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: "",
    actorId: memberId,
    action: "savings.account_open",
    targetType: "savings_account",
    targetId: account.id,
    detail: `${product.name}${targetAmount ? ` target ${formatBalance(targetAmount)}` : ""}`,
  }).catch(() => {});

  const maturityLine = maturesAt ? `\n• Matures: *${maturesAt.toDateString()}*` : "";
  const targetLine = targetAmount ? `\n• Target: *${formatBalance(targetAmount)}*` : "";
  return {
    ok: true,
    message:
      `✅ Opened *${product.name}* savings account.${targetLine}${maturityLine}\n\n` +
      `Account ID: *${account.id}*\nSave with *saveproduct ${account.id} <amount>*.`,
    accountId: account.id,
  };
}

/**
 * Move money from a member's wallet into a savings account. Wallet-funded:
 * debits the wallet and credits the product's liability account.
 */
export async function depositToProduct(
  coopId: string,
  accountId: string,
  memberId: string,
  amount: number,
): Promise<{ ok: boolean; message: string; balance?: number; progress?: ProductProgress }> {
  const account = await prisma.savingsAccount.findFirst({
    where: { id: accountId, cooperativeId: coopId },
    include: { product: true },
  });
  if (!account) return { ok: false, message: "Savings account not found." };
  if (account.memberId !== memberId) {
    return { ok: false, message: "This savings account does not belong to you." };
  }
  if (account.status !== "active") {
    return { ok: false, message: "This savings account is no longer active." };
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, message: "Enter a positive deposit amount." };
  }
  if (account.product.minAmount > 0 && amount < account.product.minAmount) {
    return {
      ok: false,
      message: `Minimum deposit for *${account.product.name}* is *${formatBalance(account.product.minAmount)}*.`,
    };
  }

  const wallet = await prisma.wallet.findUnique({ where: { memberId } });
  if (!wallet) {
    return { ok: false, message: "You need an active wallet. Reply *fund* to set one up." };
  }
  const insufficient =
    `Your wallet balance is *${formatBalance(wallet.balance)}*, less than the *${formatBalance(amount)}* deposit.\n\n` +
    `Reply *fund* to top up first.`;
  if (wallet.balance < amount) return { ok: false, message: insufficient };

  const wasComplete = productProgress(account).complete;
  let newBalance = account.balance;
  try {
    await withTx(async (tx) => {
      await setCoopContext(tx as never, coopId);
      const claimed = await tx.wallet.updateMany({
        where: { id: wallet.id, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (claimed.count === 0) throw new Error("INSUFFICIENT_BALANCE");
      const dep = await tx.savingsDeposit.create({
        data: { accountId: account.id, memberId, amount, kind: "deposit" },
      });
      const updated = await tx.savingsAccount.update({
        where: { id: account.id },
        data: { balance: { increment: amount } },
      });
      newBalance = updated.balance;
      const posted = await postJournal(
        {
          cooperativeId: coopId,
          txRef: `sav_dep_${dep.id}`,
          description: `Savings deposit: ${account.product.name}`,
          postings: [
            { account: `member_wallet:${wallet.id}`, direction: "DEBIT", amount, memberId },
            { account: productLiability(account.id), direction: "CREDIT", amount },
          ],
        },
        tx as never,
      );
      if (!posted.posted) throw new Error(`savings deposit journal not posted: ${posted.reason}`);
    });
  } catch (err) {
    if (err instanceof Error && err.message === "INSUFFICIENT_BALANCE") {
      return { ok: false, message: insufficient };
    }
    throw err;
  }

  await audit({
    cooperativeId: coopId,
    actorPhone: "",
    actorId: memberId,
    action: "savings.deposit",
    targetType: "savings_account",
    targetId: account.id,
    amount,
    detail: account.product.name,
  }).catch(() => {});

  const progress = productProgress({ balance: newBalance, targetAmount: account.targetAmount });
  if (progress.complete && !wasComplete) {
    await notifyMember(
      await loadNotifiable(memberId),
      `🎯 *Goal reached!* You've hit *${formatBalance(account.targetAmount ?? 0)}* on your *${account.product.name}* goal. Well done! 🎉`,
    ).catch(() => {});
  }

  const progressLine = progress.target
    ? `\n\nProgress: *${formatBalance(newBalance)}* of *${formatBalance(progress.target)}* (${progress.percent}%)`
    : "";
  return {
    ok: true,
    message: `✅ Deposited *${formatBalance(amount)}* into *${account.product.name}*.${progressLine}`,
    balance: newBalance,
    progress,
  };
}

/**
 * Move money out of a savings account into the member's wallet. The reverse of
 * a deposit: debits the product liability and credits the wallet.
 */
export async function withdrawFromProduct(
  coopId: string,
  accountId: string,
  memberId: string,
  amount: number,
): Promise<{ ok: boolean; message: string; balance?: number }> {
  const account = await prisma.savingsAccount.findFirst({
    where: { id: accountId, cooperativeId: coopId },
    include: { product: true },
  });
  if (!account) return { ok: false, message: "Savings account not found." };
  if (account.memberId !== memberId) {
    return { ok: false, message: "This savings account does not belong to you." };
  }
  if (account.status !== "active") {
    return { ok: false, message: "This savings account is no longer active." };
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, message: "Enter a positive withdrawal amount." };
  }
  if (amount > account.balance) {
    return {
      ok: false,
      message: `You can withdraw at most *${formatBalance(account.balance)}* from this account.`,
    };
  }

  const wallet = await prisma.wallet.findUnique({ where: { memberId } });
  if (!wallet) return { ok: false, message: "You need an active wallet to withdraw." };

  let newBalance = account.balance;
  await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    const claimed = await tx.savingsAccount.updateMany({
      where: { id: account.id, status: "active", balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (claimed.count === 0) throw new Error("INSUFFICIENT_BALANCE");
    const dep = await tx.savingsDeposit.create({
      data: { accountId: account.id, memberId, amount, kind: "withdrawal" },
    });
    newBalance = account.balance - amount;
    await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: amount } } });
    const posted = await postJournal(
      {
        cooperativeId: coopId,
        txRef: `sav_wd_${dep.id}`,
        description: `Savings withdrawal: ${account.product.name}`,
        postings: [
          { account: productLiability(account.id), direction: "DEBIT", amount },
          { account: `member_wallet:${wallet.id}`, direction: "CREDIT", amount, memberId },
        ],
      },
      tx as never,
    );
    if (!posted.posted) throw new Error(`savings withdrawal journal not posted: ${posted.reason}`);
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: "",
    actorId: memberId,
    action: "savings.withdraw",
    targetType: "savings_account",
    targetId: account.id,
    amount,
    detail: account.product.name,
  }).catch(() => {});

  return {
    ok: true,
    message: `✅ Withdrew *${formatBalance(amount)}* from *${account.product.name}*. New balance: *${formatBalance(newBalance)}*.`,
    balance: newBalance,
  };
}

/**
 * Mature (or, for open-ended goals, close) a savings account. On maturity the
 * principal plus anything the product pays at maturity lands in the member's
 * wallet, and the account is marked `matured`.
 */
export async function matureProduct(
  coopId: string,
  accountId: string,
  memberId: string,
): Promise<{ ok: boolean; message: string; credited?: number }> {
  const account = await prisma.savingsAccount.findFirst({
    where: { id: accountId, cooperativeId: coopId },
    include: { product: true },
  });
  if (!account) return { ok: false, message: "Savings account not found." };
  if (account.memberId !== memberId) {
    return { ok: false, message: "This savings account does not belong to you." };
  }
  if (account.status !== "active") {
    return { ok: false, message: "This savings account is no longer active." };
  }

  const isTermProduct = account.product.type === "fixed" || account.product.type === "seasonal";
  if (isTermProduct) {
    if (!account.maturesAt) return { ok: false, message: "This product has no maturity date." };
    if (Date.now() < account.maturesAt.getTime()) {
      return {
        ok: false,
        message: `This deposit matures on *${account.maturesAt.toDateString()}*. It cannot be matured yet.`,
      };
    }
  }

  const principal = account.balance;
  const interest = isTermProduct ? roundMoney((principal * account.product.interestRate) / 100) : 0;
  const total = principal + interest;
  if (total <= 0) return { ok: false, message: "This savings account has no balance to mature." };

  const wallet = await prisma.wallet.findUnique({ where: { memberId } });
  if (!wallet) return { ok: false, message: "You need an active wallet to mature this deposit." };

  await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    const claimed = await tx.savingsAccount.updateMany({
      where: { id: account.id, status: "active" },
      data: { status: "matured", balance: 0 },
    });
    if (claimed.count === 0) throw new Error("ALREADY_MATURED");
    if (principal > 0) {
      await tx.savingsDeposit.create({
        data: { accountId: account.id, memberId, amount: principal, kind: "withdrawal" },
      });
    }
    if (interest > 0) {
      await tx.savingsDeposit.create({
        data: { accountId: account.id, memberId, amount: interest, kind: "interest" },
      });
    }
    await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: total } } });
    const postings = [
      { account: productLiability(account.id), direction: "DEBIT" as const, amount: principal },
      {
        account: `member_wallet:${wallet.id}`,
        direction: "CREDIT" as const,
        amount: total,
        memberId,
      },
    ];
    if (interest > 0) {
      postings.push({
        account: "expense:savings_interest",
        direction: "DEBIT" as const,
        amount: interest,
      });
    }
    const posted = await postJournal(
      {
        cooperativeId: coopId,
        txRef: `sav_mature_${account.id}`,
        description: `Savings maturity: ${account.product.name}`,
        postings,
      },
      tx as never,
    );
    if (!posted.posted) throw new Error(`savings maturity journal not posted: ${posted.reason}`);
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: "",
    actorId: memberId,
    action: "savings.mature",
    targetType: "savings_account",
    targetId: account.id,
    amount: total,
    detail: `${account.product.name}${interest > 0 ? ` +${interest} interest` : ""}`,
  }).catch(() => {});

  await notifyMember(
    await loadNotifiable(memberId),
    interest > 0
      ? `🎉 *${account.product.name}* has matured! *${formatBalance(total)}* (principal *${formatBalance(principal)}* + interest *${formatBalance(interest)}*) was credited to your wallet.`
      : `🎉 *${account.product.name}* is complete! *${formatBalance(total)}* was credited to your wallet.`,
  ).catch(() => {});

  return {
    ok: true,
    message: `✅ *${account.product.name}* matured. *${formatBalance(total)}* credited to your wallet${interest > 0 ? ` (incl. *${formatBalance(interest)}* interest)` : ""}.`,
    credited: total,
  };
}

/** A member's savings accounts across all products. */
export async function listMemberProducts(
  coopId: string,
  memberId: string,
): Promise<{ ok: boolean; message: string; accounts?: MemberProductSummary[] }> {
  const rows = await prisma.savingsAccount.findMany({
    where: { cooperativeId: coopId, memberId },
    include: { product: true },
    orderBy: { createdAt: "desc" },
  });
  const accounts = rows.map((a) => ({
    id: a.id,
    productId: a.productId,
    productName: a.product.name,
    type: a.product.type,
    balance: a.balance,
    targetAmount: a.targetAmount,
    status: a.status,
    maturesAt: a.maturesAt,
    progress: productProgress(a),
  }));
  return {
    ok: true,
    message: accounts.length ? `${accounts.length} savings account(s).` : "You have no product savings yet.",
    accounts,
  };
}

/** Load the fields notifyMember needs, tolerating a missing member. */
async function loadNotifiable(memberId: string) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { phone: true, optedOut: true, preferredChannel: true, altChannelId: true },
  });
  return (
    member ?? { phone: "", optedOut: false, preferredChannel: null, altChannelId: null }
  );
}
