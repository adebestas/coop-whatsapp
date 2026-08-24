/**
 * AI Data Access Layer — provides read-only aggregated financial data
 * for the AI to answer natural language questions about the cooperative.
 *
 * SECURITY: All queries are scoped to a single cooperative. No PII is exposed
 * to the AI — only aggregated numbers and member codes. Individual balances
 * require member authentication before the AI can access them.
 */

import { prisma } from "./prisma.js";

export interface CoopSnapshot {
  cooperative: {
    name: string;
    code: string;
    currency: string;
    memberCount: number;
    activeMemberCount: number;
  };
  finances: {
    totalSaved: number;
    totalWalletBalance: number;
    activeLoanBalance: number;
    totalDisbursed: number;
    totalRepaid: number;
    pendingWithdrawals: number;
    pendingWithdrawalAmount: number;
    todayPayoutTotal: number;
    dailyPayoutLimit: number;
  };
  contributions: {
    thisMonth: number;
    lastMonth: number;
    thisYear: number;
    count: number;
  };
  loans: {
    pending: number;
    approved: number;
    disbursed: number;
    paid: number;
    rejected: number;
    averageInterestRate: number;
  };
  recentActivity: {
    recentContributions: number;
    recentWithdrawals: number;
    recentLoans: number;
  };
}

export interface MemberSnapshot {
  name: string;
  code: string;
  role: string;
  walletBalance: number;
  totalSaved: number;
  activeLoan: {
    amount: number;
    balance: number;
    monthlyPayment: number;
    dueDate: string | null;
  } | null;
  contributionCount: number;
  lastContributionDate: string | null;
  lastWithdrawalDate: string | null;
  memberSince: string;
}

/**
 * Get a snapshot of the cooperative's financial health for AI queries.
 */
export async function getCoopSnapshot(cooperativeId: string): Promise<CoopSnapshot> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });

  const [memberCount, activeMemberCount] = await Promise.all([
    prisma.member.count({ where: { cooperativeId } }),
    prisma.member.count({ where: { cooperativeId, status: "active" } }),
  ]);

  const walletAgg = await prisma.wallet.aggregate({
    where: { member: { cooperativeId } },
    _sum: { balance: true, totalSaved: true },
  });

  const [contributionThisMonth, contributionLastMonth, contributionThisYear] = await Promise.all([
    prisma.contribution.aggregate({
      where: { cooperativeId, status: "confirmed", createdAt: { gte: startOfMonth } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.contribution.aggregate({
      where: { cooperativeId, status: "confirmed", createdAt: { gte: startOfLastMonth, lt: startOfMonth } },
      _sum: { amount: true },
    }),
    prisma.contribution.aggregate({
      where: { cooperativeId, status: "confirmed", createdAt: { gte: startOfYear } },
      _sum: { amount: true },
    }),
  ]);

  const loanStats = await prisma.loan.groupBy({
    by: ["status"],
    where: { cooperativeId },
    _count: true,
    _sum: { balance: true, amount: true },
    _avg: { interestRate: true },
  });

  const withdrawalStats = await prisma.withdrawalRequest.aggregate({
    where: { cooperativeId, status: { in: ["pending", "admin_approved"] } },
    _count: true,
    _sum: { amount: true },
  });

  const payoutStats = await prisma.payout.aggregate({
    where: { cooperativeId, status: "successful", createdAt: { gte: oneDayAgo } },
    _sum: { amount: true },
  });

  const [recentContributions, recentWithdrawals, recentLoans] = await Promise.all([
    prisma.contribution.count({ where: { cooperativeId, createdAt: { gte: thirtyDaysAgo } } }),
    prisma.withdrawalRequest.count({ where: { cooperativeId, createdAt: { gte: thirtyDaysAgo } } }),
    prisma.loan.count({ where: { cooperativeId, createdAt: { gte: thirtyDaysAgo } } }),
  ]);

  const loanMap = new Map(loanStats.map((l) => [l.status, l]));

  return {
    cooperative: {
      name: coop?.name ?? "Unknown",
      code: coop?.code ?? "",
      currency: coop?.currency ?? "NGN",
      memberCount,
      activeMemberCount,
    },
    finances: {
      totalSaved: walletAgg._sum.totalSaved ?? 0,
      totalWalletBalance: walletAgg._sum.balance ?? 0,
      activeLoanBalance:
        (loanMap.get("disbursed")?._sum.balance ?? 0) + (loanMap.get("approved")?._sum.balance ?? 0),
      totalDisbursed: loanMap.get("disbursed")?._sum.amount ?? 0,
      totalRepaid:
        (loanMap.get("disbursed")?._sum.amount ?? 0) - (loanMap.get("disbursed")?._sum.balance ?? 0),
      pendingWithdrawals: withdrawalStats._count,
      pendingWithdrawalAmount: withdrawalStats._sum.amount ?? 0,
      todayPayoutTotal: payoutStats._sum.amount ?? 0,
      dailyPayoutLimit: coop?.dailyPayoutLimit ?? 0,
    },
    contributions: {
      thisMonth: contributionThisMonth._sum.amount ?? 0,
      lastMonth: contributionLastMonth._sum.amount ?? 0,
      thisYear: contributionThisYear._sum.amount ?? 0,
      count: contributionThisMonth._count,
    },
    loans: {
      pending: loanMap.get("pending")?._count ?? 0,
      approved: loanMap.get("approved")?._count ?? 0,
      disbursed: loanMap.get("disbursed")?._count ?? 0,
      paid: loanMap.get("paid")?._count ?? 0,
      rejected: loanMap.get("rejected")?._count ?? 0,
      averageInterestRate: loanMap.get("disbursed")?._avg.interestRate ?? 0,
    },
    recentActivity: {
      recentContributions,
      recentWithdrawals,
      recentLoans,
    },
  };
}

/**
 * Get a member's personal financial snapshot for AI queries.
 */
export async function getMemberSnapshot(memberId: string): Promise<MemberSnapshot | null> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: {
      wallet: true,
      loans: {
        where: { status: { in: ["approved", "disbursed"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      contributions: {
        where: { status: "confirmed" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      _count: { select: { contributions: { where: { status: "confirmed" } } } },
    },
  });

  if (!member) return null;

  const activeLoan = member.loans[0];
  const lastContribution = member.contributions[0];

  return {
    name: member.name,
    code: member.code,
    role: member.role,
    walletBalance: member.wallet?.balance ?? 0,
    totalSaved: member.wallet?.totalSaved ?? 0,
    activeLoan: activeLoan
      ? {
          amount: activeLoan.amount,
          balance: activeLoan.balance,
          monthlyPayment: activeLoan.monthlyPayment ?? 0,
          dueDate: activeLoan.dueDate?.toISOString() ?? null,
        }
      : null,
    contributionCount: member._count.contributions,
    lastContributionDate: lastContribution?.createdAt.toISOString() ?? null,
    lastWithdrawalDate: member.lastWithdrawalAt?.toISOString() ?? null,
    memberSince: member.createdAt.toISOString(),
  };
}

/**
 * Get savings trend data for AI insights.
 */
export async function getSavingsTrend(cooperativeId: string, months: number = 6) {
  const now = new Date();
  const trends: { month: string; amount: number; count: number }[] = [];

  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

    const result = await prisma.contribution.aggregate({
      where: {
        cooperativeId,
        status: "confirmed",
        createdAt: { gte: start, lte: end },
      },
      _sum: { amount: true },
      _count: true,
    });

    trends.push({
      month: start.toISOString().slice(0, 7),
      amount: result._sum.amount ?? 0,
      count: result._count,
    });
  }

  return trends;
}

/**
 * Get loan performance data for AI insights.
 */
export async function getLoanPerformance(cooperativeId: string) {
  const [totalLoans, paidLoans, defaultedLoans, avgRepayment] = await Promise.all([
    prisma.loan.count({ where: { cooperativeId } }),
    prisma.loan.count({ where: { cooperativeId, status: "paid" } }),
    prisma.loan.count({
      where: {
        cooperativeId,
        status: "disbursed",
        dueDate: { lt: new Date() },
      },
    }),
    prisma.loanRepayment.aggregate({
      where: { loan: { cooperativeId } },
      _avg: { amount: true },
    }),
  ]);

  return {
    totalLoans,
    paidLoans,
    repaymentRate: totalLoans > 0 ? (paidLoans / totalLoans) * 100 : 0,
    defaultedLoans,
    avgRepaymentAmount: avgRepayment._avg.amount ?? 0,
  };
}
