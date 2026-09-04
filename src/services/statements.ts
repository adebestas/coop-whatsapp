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

  // Member rows have a direct `unitId`; Contribution/Loan/Payout do NOT, so
  // unit-scoped money aggregates must filter through the `member` relation
  // instead of passing `unitId` straight into the model's where clause.
  const unitScope = member.unit ? { unitId: member.unit.id } : {};
  const memberScope = { cooperativeId: coopId, ...unitScope };
  const isUnitAdmin = await prisma.unit.findFirst({ where: { adminMemberId: member.id } });

  const [memberCount, contributions, loans, payouts, walletAgg, lastDividend] = await Promise.all([
    prisma.member.count({ where: memberScope }),
    prisma.contribution.aggregate({
      where: { cooperativeId: coopId, ...(member.unit ? { member: unitScope } : {}), status: "confirmed" },
      _sum: { amount: true },
    }),
    prisma.loan.aggregate({
      where: { cooperativeId: coopId, ...(member.unit ? { member: unitScope } : {}), status: { in: ["approved", "disbursed"] } },
      _sum: { balance: true },
    }),
    prisma.payout.aggregate({
      where: { cooperativeId: coopId, ...(member.unit ? { member: unitScope } : {}) },
      _sum: { amount: true },
    }),
    prisma.wallet.aggregate({ where: { member: memberScope }, _sum: { balance: true } }),
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

const MONTHS = [
  "january","february","march","april","may","june",
  "july","august","september","october","november","december"
];

function parseMonthYear(args: string): { year: number; month: number } | null {
  const now = new Date();
  const parts = args.trim().toLowerCase().split(/\s+/);
  if (parts.length === 1) {
    const m = MONTHS.indexOf(parts[0]);
    if (m >= 0) return { year: now.getFullYear(), month: m + 1 };
    return null;
  }
  if (parts.length === 2) {
    const m = MONTHS.indexOf(parts[0]);
    const y = parseInt(parts[1], 10);
    if (m >= 0 && y > 2000 && y < 2100) return { year: y, month: m + 1 };
    return null;
  }
  return null;
}

export async function getMonthlyStatement(phone: string, args: string): Promise<{ ok: boolean; message: string }> {
  const parsed = parseMonthYear(args);
  if (!parsed) return { ok: false, message: "Usage: *statement august 2026* or just *statement* for current month." };

  const member = await prisma.member.findFirst({
    where: { phone },
    include: { cooperative: true, wallet: true },
  });
  if (!member) return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };

  const start = new Date(parsed.year, parsed.month - 1, 1);
  const end = new Date(parsed.year, parsed.month, 0, 23, 59, 59, 999);
  const monthName = start.toLocaleString("en-GB", { month: "long", year: "numeric" });

  const [contributions, loanRepayments, dividends, withdrawals, activeLoan] = await Promise.all([
    prisma.contribution.findMany({
      where: { memberId: member.id, status: "confirmed", createdAt: { gte: start, lte: end } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.loanRepayment.findMany({
      where: { loan: { memberId: member.id }, paidAt: { gte: start, lte: end } },
      orderBy: { paidAt: "asc" },
    }),
    prisma.dividendEntry.findMany({
      where: { memberId: member.id, createdAt: { gte: start, lte: end } },
      include: { dividend: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.payout.findMany({
      where: { memberId: member.id, createdAt: { gte: start, lte: end } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.loan.findFirst({ where: { memberId: member.id, status: { in: ["approved", "disbursed"] } } }),
  ]);

  const totalContributions = contributions.reduce((s, c) => s + c.amount, 0);
  const totalRepaid = loanRepayments.reduce((s, r) => s + r.amount, 0);
  const totalDividends = dividends.reduce((s, d) => s + d.amount, 0);
  const totalWithdrawn = withdrawals.reduce((s, w) => s + w.amount, 0);

  const lines = [
    `📊 *Monthly Statement — ${monthName}*`,
    ``,
    `👤 Member: *${member.name}*`,
    `🏛️ Cooperative: *${member.cooperative.name}*`,
    ``,
    `💰 *Savings & Contributions*`,
    `• Deposits this month: ${formatBalance(totalContributions)}`,
    `• Dividends received: ${formatBalance(totalDividends)}`,
    `• Withdrawals: -${formatBalance(totalWithdrawn)}`,
    `• Current balance: ${formatBalance(member.wallet?.balance ?? 0)}`,
  ];

  if (activeLoan) {
    lines.push(
      ``,
      `🏦 *Loan*`,
      `• Loan amount: ${formatBalance(activeLoan.amount)}`,
      `• Repaid this month: ${formatBalance(totalRepaid)}`,
      `• Outstanding balance: ${formatBalance(activeLoan.balance)}`,
    );
  }

  const netChange = totalContributions + totalDividends - totalWithdrawn;
  lines.push(
    ``,
    `📈 *Summary*`,
    `• Net change: ${netChange >= 0 ? "+" : ""}${formatBalance(Math.abs(netChange))}`,
  );

  return { ok: true, message: lines.join("\n") };
}

export async function getYearlyStatement(phone: string, year: number): Promise<{ ok: boolean; message: string }> {
  const member = await prisma.member.findFirst({
    where: { phone },
    include: { cooperative: true, wallet: true },
  });
  if (!member) return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };

  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31, 23, 59, 59, 999);

  const [contributions, loanRepayments, dividends, withdrawals, loans] = await Promise.all([
    prisma.contribution.aggregate({
      where: { memberId: member.id, status: "confirmed", createdAt: { gte: start, lte: end } },
      _sum: { amount: true },
    }),
    prisma.loanRepayment.aggregate({
      where: { loan: { memberId: member.id }, paidAt: { gte: start, lte: end } },
      _sum: { amount: true },
    }),
    prisma.dividendEntry.aggregate({
      where: { memberId: member.id, createdAt: { gte: start, lte: end } },
      _sum: { amount: true },
    }),
    prisma.payout.aggregate({
      where: { memberId: member.id, createdAt: { gte: start, lte: end } },
      _sum: { amount: true },
    }),
    prisma.loan.findMany({
      where: { memberId: member.id, createdAt: { gte: start, lte: end } },
      select: { amount: true, balance: true, status: true },
    }),
  ]);

  const totalContrib = contributions._sum.amount ?? 0;
  const totalRepaid = loanRepayments._sum?.amount ?? 0;
  const totalDividends = dividends._sum.amount ?? 0;
  const totalWithdrawn = withdrawals._sum.amount ?? 0;

  const lines = [
    `📊 *Yearly Statement — ${year}*`,
    ``,
    `👤 Member: *${member.name}*`,
    `🏛️ Cooperative: *${member.cooperative.name}*`,
    ``,
    `💰 *Financial Summary*`,
    `• Total contributions: ${formatBalance(totalContrib)}`,
    `• Total dividends: ${formatBalance(totalDividends)}`,
    `• Total withdrawals: -${formatBalance(totalWithdrawn)}`,
    `• Current balance: ${formatBalance(member.wallet?.balance ?? 0)}`,
  ];

  if (loans.length > 0) {
    const totalBorrowed = loans.reduce((s, l) => s + l.amount, 0);
    const totalOutstanding = loans.reduce((s, l) => s + l.balance, 0);
    lines.push(
      ``,
      `🏦 *Loan Activity*`,
      `• Loans taken: ${loans.length}`,
      `• Total borrowed: ${formatBalance(totalBorrowed)}`,
      `• Total repaid: ${formatBalance(totalRepaid)}`,
      `• Outstanding: ${formatBalance(totalOutstanding)}`,
    );
  }

  const netChange = totalContrib + totalDividends - totalWithdrawn;
  lines.push(
    ``,
    `📈 *Year Summary*`,
    `• Net growth: ${netChange >= 0 ? "+" : ""}${formatBalance(Math.abs(netChange))}`,
  );

  return { ok: true, message: lines.join("\n") };
}