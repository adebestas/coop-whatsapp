import { prisma, withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import { postJournal } from "./journal.js";
import { formatBalance } from "./cooperative.js";
import { computePnl } from "./ledger.js";
import { audit } from "./audit.js";

const DEFAULT_SHARE_PRICE = 100000; // kobo (₦1,000)
const MAX_DIVIDEND_RATE = 25; // per Nigerian Cooperative Societies Act

/** Largest-remainder (Hamilton) allocation of `pool` kobo across shareholdings. */
export function allocateByShares(
  holdings: { id: string; shares: number }[],
  pool: number,
): Map<string, number> {
  const eligible = holdings.filter((h) => h.shares > 0);
  const totalShares = eligible.reduce((sum, h) => sum + h.shares, 0);
  const out = new Map<string, number>();
  if (totalShares <= 0 || pool <= 0) return out;

  const raw = eligible.map((h) => {
    const exact = (h.shares / totalShares) * pool;
    const kobo = Math.floor(exact);
    return { id: h.id, kobo, remainder: exact - kobo };
  });
  let leftover = pool - raw.reduce((sum, r) => sum + r.kobo, 0);
  raw.sort((a, b) => b.remainder - a.remainder);
  for (const r of raw) {
    if (leftover <= 0) break;
    r.kobo += 1;
    leftover -= 1;
  }
  for (const r of raw) out.set(r.id, r.kobo);
  return out;
}

export async function getShareAccount(memberId: string): Promise<{
  shares: number;
  totalPaid: number;
  pricePerShare: number;
  value: number;
} | null> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: { cooperative: { include: { config: true } } },
  });
  if (!member) return null;
  const pricePerShare = member.cooperative.config?.sharePrice ?? DEFAULT_SHARE_PRICE;
  const account = await prisma.shareAccount.findFirst({ where: { memberId } });
  const shares = account?.shares ?? 0;
  return {
    shares,
    totalPaid: account?.totalPaid ?? 0,
    pricePerShare,
    value: shares * pricePerShare,
  };
}

export async function buyShares(
  memberId: string,
  count: number,
): Promise<{ ok: boolean; message: string }> {
  if (!Number.isInteger(count) || count <= 0) {
    return { ok: false, message: "Enter a whole number of shares, e.g. *buyshares 5*." };
  }

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: { wallet: true, cooperative: { include: { config: true } } },
  });
  if (!member || !member.wallet) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };
  }

  const price = member.cooperative.config?.sharePrice ?? DEFAULT_SHARE_PRICE;
  const minShares = member.cooperative.config?.minShares ?? 1;
  const maxShares = member.cooperative.config?.maxShares ?? 0;
  const cost = price * count;

  if (count < minShares) {
    return { ok: false, message: `The minimum purchase is *${minShares}* share(s).` };
  }

  // Validate BEFORE creating the account: a refused purchase must leave no
  // ShareAccount behind (the test asserts null after an underfunded attempt).
  const existing = await prisma.shareAccount.findFirst({
    where: { cooperativeId: member.cooperativeId, memberId },
  });
  if (maxShares > 0 && (existing?.shares ?? 0) + count > maxShares) {
    return { ok: false, message: `You can hold at most *${maxShares}* shares.` };
  }
  const insufficientBalanceMessage =
    `Buying *${count}* share(s) costs *${formatBalance(cost)}* but your savings balance is ` +
    `*${formatBalance(member.wallet.balance)}*.\n\nReply *save <amount>* to top up first.`;
  if (member.wallet.balance < cost) {
    return { ok: false, message: insufficientBalanceMessage };
  }

  const account = await prisma.shareAccount.upsert({
    where: { cooperativeId_memberId: { cooperativeId: member.cooperativeId, memberId } },
    create: { cooperativeId: member.cooperativeId, memberId },
    update: {},
  });

  const reference = `SHARE-BUY-${member.cooperativeId}-${memberId}-${Date.now()}`;
  const walletId = member.wallet.id;

  try {
    await withTx(async (tx) => {
      await setCoopContext(tx as never, member.cooperativeId);
      // Authoritative race guard: only debit if the wallet still covers the cost.
      // The balance pre-check above is just the fast path; concurrent purchases
      // could otherwise drive the balance negative.
      const claimed = await tx.wallet.updateMany({
        where: { id: walletId, balance: { gte: cost } },
        data: { balance: { decrement: cost } },
      });
      if (claimed.count === 0) throw new Error("INSUFFICIENT_BALANCE");
      await tx.shareAccount.update({
        where: { id: account.id },
        data: { shares: { increment: count }, totalPaid: { increment: cost } },
      });
      await tx.shareTransaction.create({
        data: {
          cooperativeId: member.cooperativeId,
          memberId,
          shareAccountId: account.id,
          type: "purchase",
          shares: count,
          amount: cost,
          pricePerShare: price,
          reference,
        },
      });
      await postJournal(
        {
          cooperativeId: member.cooperativeId,
          txRef: reference,
          description: `Share purchase: ${count} share(s)`,
          postings: [
            { account: `member_wallet:${walletId}`, direction: "DEBIT", amount: cost, memberId },
            { account: "equity:share_capital", direction: "CREDIT", amount: cost },
          ],
        },
        tx as any,
      );
    });
  } catch (err) {
    if (err instanceof Error && err.message === "INSUFFICIENT_BALANCE") {
      return { ok: false, message: insufficientBalanceMessage };
    }
    throw err;
  }

  await audit({
    cooperativeId: member.cooperativeId,
    actorPhone: member.phone,
    actorId: memberId,
    actorRole: member.role,
    action: "shares.buy",
    targetType: "share_account",
    targetId: account.id,
    amount: cost,
    detail: `${count} share(s) @ ${price} kobo`,
  }).catch(() => {});

  const newShares = account.shares + count;
  return {
    ok: true,
    message:
      `✅ You bought *${count}* share(s) for *${formatBalance(cost)}*.\n\n` +
      `You now hold *${newShares}* share(s) worth *${formatBalance(newShares * price)}*.`,
  };
}

export async function distributeShareDividend(
  phone: string,
  rate: number,
): Promise<{ ok: boolean; message: string; pool?: number; paid?: number }> {
  const admin = await prisma.member.findFirst({ where: { phone, role: "superadmin" } });
  if (!admin) return { ok: false, message: "Only the super admin can pay dividends." };
  if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_DIVIDEND_RATE) {
    return { ok: false, message: `Rate must be between 0 and ${MAX_DIVIDEND_RATE}.` };
  }

  const pnl = await computePnl(admin.cooperativeId);
  if (pnl.netProfit <= 0) {
    return { ok: false, message: `There's no profit to share yet (net: ${formatBalance(pnl.netProfit)}).` };
  }

  const accounts = await prisma.shareAccount.findMany({
    where: { cooperativeId: admin.cooperativeId, shares: { gt: 0 } },
    select: {
      id: true,
      memberId: true,
      shares: true,
      member: { select: { name: true, wallet: { select: { id: true } } } },
    },
  });
  const totalShares = accounts.reduce((sum, a) => sum + a.shares, 0);
  if (totalShares <= 0) {
    return { ok: false, message: "No shares have been issued yet — nothing to distribute against." };
  }

  const reserve = Math.floor(pnl.netProfit * 0.2);
  const education = Math.floor(pnl.netProfit * 0.02);
  const development = Math.floor(pnl.netProfit * 0.05);
  const distributable = Math.max(0, pnl.netProfit - reserve - education - development);
  const pool = Math.max(0, Math.round(distributable * (rate / 100)));
  if (pool <= 0) {
    return { ok: false, message: "After statutory deductions there's no distributable profit left." };
  }

  const allocation = allocateByShares(
    accounts.map((a) => ({ id: a.memberId, shares: a.shares })),
    pool,
  );
  const reference = `SHARE-DIV-${Date.now()}`;
  let paid = 0;

  await withTx(async (tx) => {
    await setCoopContext(tx as never, admin.cooperativeId);
    for (const a of accounts) {
      const amount = allocation.get(a.memberId) ?? 0;
      if (amount <= 0 || !a.member.wallet) continue;
      await tx.wallet.update({
        where: { id: a.member.wallet.id },
        data: { balance: { increment: amount } },
      });
      await tx.shareTransaction.create({
        data: {
          cooperativeId: admin.cooperativeId,
          memberId: a.memberId,
          shareAccountId: a.id,
          type: "dividend",
          shares: 0,
          amount,
          pricePerShare: 0,
          reference: `${reference}-${a.memberId}`,
          note: `Share dividend at ${rate}%`,
        },
      });
      await postJournal(
        {
          cooperativeId: admin.cooperativeId,
          txRef: `${reference}-${a.memberId}`,
          description: `Share dividend to ${a.member.name}`,
          postings: [
            { account: "appropriation:dividend", direction: "DEBIT", amount },
            { account: `member_wallet:${a.member.wallet.id}`, direction: "CREDIT", amount, memberId: a.memberId },
          ],
        },
        tx as any,
      );
      paid++;
    }
  });

  await audit({
    cooperativeId: admin.cooperativeId,
    actorPhone: admin.phone,
    actorId: admin.id,
    actorRole: admin.role,
    action: "shares.dividend",
    targetType: "share_dividend",
    targetId: reference,
    amount: pool,
    detail: `Share dividend at ${rate}% to ${paid} member(s)`,
  }).catch(() => {});

  return {
    ok: true,
    message:
      `🎉 *Share dividend paid*\n\n` +
      `Rate: *${rate}%* of net profit ${formatBalance(pnl.netProfit)}\n` +
      `Pool: *${formatBalance(pool)}*\n` +
      `Credited to *${paid}* shareholder(s).`,
    pool,
    paid,
  };
}
