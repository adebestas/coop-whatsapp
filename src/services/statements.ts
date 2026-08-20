import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";

/**
 * Transparent ledger for a cooperative or a unit within it.
 * Lets every member see aggregate totals — no "money soup" worries.
 */
export async function showLedger(phone: string): Promise<{ ok: boolean; message: string }> {
  const member = await prisma.member.findFirst({ where: { phone }, include: { cooperative: true, unit: true } });
  if (!member) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };
  }
  const coopId = member.cooperativeId;

  const scope = member.unit ? { cooperativeId: coopId, unitId: member.unit.id } : { cooperativeId: coopId };
  const isUnitAdmin = await prisma.unit.findFirst({ where: { adminMemberId: member.id } });

  const [memberCount, contributions, loans, payouts, walletAgg, lastDividend] = await Promise.all([
    prisma.member.count({ where: scope }),
    prisma.contribution.aggregate({ where: { ...scope, status: "confirmed" }, _sum: { amount: true } }),
    prisma.loan.aggregate({ where: { ...scope, status: { in: ["approved", "disbursed"] } }, _sum: { balance: true } }),
    prisma.payout.aggregate({ where: scope, _sum: { amount: true } }),
    prisma.wallet.aggregate({ where: { member: scope }, _sum: { balance: true } }),
    prisma.dividend.findFirst({ where: { cooperativeId: coopId }, orderBy: { createdAt: "desc" } }),
  ]);

  const scopeLabel = member.unit ? member.unit.name : member.cooperative.name;
  const lines = [
    `*📒 Ledger — ${scopeLabel}*`,
    ``,
    `👥 Members: ${memberCount}`,
    `💰 Total savings in: ${formatBalance(contributions._sum.amount ?? 0)}`,
    `🏦 Current wallet total: ${formatBalance(walletAgg._sum.balance ?? 0)}`,
    `📉 Loans outstanding: ${formatBalance(loans._sum.balance ?? 0)}`,
    `💸 Payouts paid out: ${formatBalance(payouts._sum.amount ?? 0)}`,
  ];

  if (lastDividend) {
    lines.push(`🎉 Last dividend: ${lastDividend.rate}% → pool ${formatBalance(lastDividend.totalPool)} (${lastDividend.status})`);
  }

  if (isUnitAdmin) {
    const unitBreakdown = await prisma.unit.findMany({
      where: { cooperativeId: coopId },
      include: { _count: { select: { members: true } } },
    });
    lines.push(``, `*By workplace:*`);
    for (const u of unitBreakdown) {
      lines.push(`• ${u.name} (${u.code}) — ${u._count.members} members`);
    }
  } else if (member.unit) {
    lines.push(``, `Your workplace: *${member.unit.name}* (${member.unit.code}). Reply *history* for your personal statement.`);
  }

  return { ok: true, message: lines.join("\n") };
}

/** Personal transaction statement for a member. */
export async function showHistory(phone: string): Promise<{ ok: boolean; message: string }> {
  const member = await prisma.member.findFirst({
    where: { phone },
    include: { cooperative: true, wallet: true, contributions: true, dividendEntries: { include: { dividend: true } } },
  });
  if (!member) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };
  }

  const [loans, payouts] = await Promise.all([
    prisma.loan.findMany({ where: { memberId: member.id }, orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.payout.findMany({ where: { memberId: member.id }, orderBy: { createdAt: "desc" }, take: 5 }),
  ]);

  const lines = [`*Your statement — ${member.cooperative.name}*`, ``];
  const fmt = (d: Date) => d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  if (member.contributions.length > 0) {
    lines.push(`*Deposits (latest ${Math.min(member.contributions.length, 10)}):*`);
    for (const c of member.contributions.slice(-10).reverse()) {
      const tag = c.type === "topup" ? "transfer" : c.type === "interest" ? "interest" : c.type === "dividend" ? "dividend" : "savings";
      lines.push(`• ${fmt(c.paidAt ?? c.createdAt)} — +${formatBalance(c.amount)} (${tag})`);
    }
  }

  if (loans.length > 0) {
    lines.push(``, `*Loans:*`);
    for (const l of loans) {
      lines.push(`• ${l.status} — ${formatBalance(l.amount)} (${l.tenureMonths}mo) — balance ${formatBalance(l.balance)}`);
    }
  }

  if (payouts.length > 0) {
    lines.push(``, `*Payouts:*`);
    for (const p of payouts) {
      lines.push(`• ${fmt(p.createdAt)} — ${formatBalance(p.amount)} (${p.status})`);
    }
  }

  if (member.dividendEntries.length > 0) {
    lines.push(``, `*Dividends received:*`);
    for (const d of member.dividendEntries) {
      lines.push(`• ${d.status} — +${formatBalance(d.amount)} (rate ${d.dividend.rate}%)`);
    }
  }

  lines.push(``, `Balance: *${formatBalance(member.wallet?.balance ?? 0)}*`);
  return { ok: true, message: lines.join("\n") };
}