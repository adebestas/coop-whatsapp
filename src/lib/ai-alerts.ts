/**
 * Proactive Intelligence — smart alerts, reminders, and trend notifications.
 *
 * This module provides:
 * - Savings reminders for members who haven't contributed recently
 * - Loan repayment reminders when due dates approach
 * - Overdue loan alerts
 * - Savings trend alerts (positive/negative)
 * - Low balance warnings
 * - Monthly financial summaries
 *
 * All alerts are opt-in and respect member preferences.
 */

import { prisma } from "./prisma.js";
import { sendText } from "../lib/messaging.js";
import { formatBalance } from "../services/cooperative.js";

/**
 * Send savings reminders to members who haven't contributed this month.
 */
export async function sendSavingsReminders(cooperativeId: string): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const members = await prisma.member.findMany({
    where: {
      cooperativeId,
      status: "active",
      consentAt: { not: null },
    },
    include: {
      contributions: {
        where: {
          status: "confirmed",
          createdAt: { gte: startOfMonth },
        },
        take: 1,
      },
    },
  });

  let sent = 0;
  for (const member of members) {
    if (member.contributions.length > 0) continue;

    await sendText({
      to: member.phone,
      text:
        `💰 *Monthly Savings Reminder*\n\n` +
        `Hi ${member.name}, you haven't made a contribution this month yet.\n\n` +
        `Reply *save <amount>* to save now, or *skipmonth* if you need to skip this month.`,
    });
    sent++;
  }

  return sent;
}

/**
 * Send loan repayment reminders to members with upcoming due dates.
 */
export async function sendLoanReminders(cooperativeId: string): Promise<number> {
  const now = new Date();
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const loans = await prisma.loan.findMany({
    where: {
      cooperativeId,
      status: { in: ["approved", "disbursed"] },
      dueDate: { gte: now, lte: sevenDaysFromNow },
    },
    include: { member: { where: { consentAt: { not: null } } } },
  });

  let sent = 0;
  for (const loan of loans) {
    if (!loan.member) continue;
    const daysUntilDue = Math.ceil(
      (loan.dueDate!.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
    );

    await sendText({
      to: loan.member.phone,
      text:
        `⏰ *Loan Repayment Reminder*\n\n` +
        `Your loan repayment of ${formatBalance(loan.monthlyPayment ?? 0)} is due in ${daysUntilDue} day(s).\n\n` +
        `Reply *repay <amount>* to make a payment.`,
    });
    sent++;
  }

  return sent;
}

/**
 * Send overdue loan alerts to members and admins.
 */
export async function sendOverdueAlerts(cooperativeId: string): Promise<number> {
  const now = new Date();

  const overdueLoans = await prisma.loan.findMany({
    where: {
      cooperativeId,
      status: "disbursed",
      dueDate: { lt: now },
    },
    include: { member: { where: { consentAt: { not: null } } } },
  });

  let sent = 0;
  for (const loan of overdueLoans) {
    if (!loan.member) continue;
    const daysOverdue = Math.ceil(
      (now.getTime() - loan.dueDate!.getTime()) / (24 * 60 * 60 * 1000),
    );

    await sendText({
      to: loan.member.phone,
      text:
        `🚨 *Overdue Loan Alert*\n\n` +
        `Your loan repayment of ${formatBalance(loan.monthlyPayment ?? 0)} is ${daysOverdue} day(s) overdue.\n\n` +
        `Remaining balance: ${formatBalance(loan.balance)}\n\n` +
        `Reply *repay <amount>* to make a payment, or contact admin.`,
    });
    sent++;
  }

  return sent;
}

/**
 * Send low balance warnings to members with insufficient funds for upcoming obligations.
 */
export async function sendLowBalanceWarnings(cooperativeId: string): Promise<number> {
  const members = await prisma.member.findMany({
    where: { cooperativeId, status: "active", consentAt: { not: null } },
    include: {
      wallet: true,
      loans: {
        where: { status: { in: ["approved", "disbursed"] } },
        take: 1,
      },
    },
  });

  let sent = 0;
  for (const member of members) {
    if (!member.wallet) continue;

    const activeLoan = member.loans[0];
    if (!activeLoan) continue;

    const monthlyPayment = activeLoan.monthlyPayment ?? 0;
    if (monthlyPayment === 0) continue;

    // Warn if wallet balance is less than 1.5x monthly payment
    if (member.wallet.balance < monthlyPayment * 1.5) {
      await sendText({
        to: member.phone,
        text:
          `⚠️ *Low Balance Warning*\n\n` +
          `Your wallet balance is ${formatBalance(member.wallet.balance)}, ` +
          `but your upcoming loan payment is ${formatBalance(monthlyPayment)}.\n\n` +
          `Reply *save <amount>* to top up your wallet.`,
      });
      sent++;
    }
  }

  return sent;
}

/**
 * Send savings trend alerts based on recent contribution patterns.
 */
export async function sendTrendAlerts(cooperativeId: string): Promise<number> {
  const now = new Date();
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [thisMonth, lastMonth] = await Promise.all([
    prisma.contribution.aggregate({
      where: {
        cooperativeId,
        status: "confirmed",
        createdAt: { gte: startOfThisMonth },
      },
      _sum: { amount: true },
    }),
    prisma.contribution.aggregate({
      where: {
        cooperativeId,
        status: "confirmed",
        createdAt: { gte: startOfLastMonth, lt: startOfThisMonth },
      },
      _sum: { amount: true },
    }),
  ]);

  const thisMonthAmount = thisMonth._sum.amount ?? 0;
  const lastMonthAmount = lastMonth._sum.amount ?? 0;

  if (lastMonthAmount === 0 || thisMonthAmount === 0) return 0;

  const changePercent = ((thisMonthAmount - lastMonthAmount) / lastMonthAmount) * 100;

  // Only alert on significant changes (>20%)
  if (Math.abs(changePercent) < 20) return 0;

  const members = await prisma.member.findMany({
    where: { cooperativeId, status: "active", consentAt: { not: null } },
  });

  let sent = 0;
  for (const member of members) {
    const direction = changePercent > 0 ? "up" : "down";
    const emoji = changePercent > 0 ? "📈" : "📉";

    await sendText({
      to: member.phone,
      text:
        `${emoji} *Savings Trend Alert*\n\n` +
        `Contributions are ${direction} ${Math.abs(changePercent).toFixed(1)}% this month.\n\n` +
        `This month: ${formatBalance(thisMonthAmount)}\n` +
        `Last month: ${formatBalance(lastMonthAmount)}\n\n` +
        `${changePercent > 0 ? "Great job! Let's keep it up." : "Let's work together to improve!"}`,
    });
    sent++;
  }

  return sent;
}

/**
 * Send monthly financial summaries to all active members.
 */
export async function sendMonthlySummaries(cooperativeId: string): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const members = await prisma.member.findMany({
    where: { cooperativeId, status: "active", consentAt: { not: null } },
    include: {
      wallet: true,
      contributions: {
        where: {
          status: "confirmed",
          createdAt: { gte: startOfMonth },
        },
      },
      loans: {
        where: { status: { in: ["approved", "disbursed"] } },
      },
    },
  });

  let sent = 0;
  for (const member of members) {
    const totalSaved = member.contributions.reduce((sum, c) => sum + c.amount, 0);
    const activeLoan = member.loans[0];
    const loanBalance = activeLoan?.balance ?? 0;

    await sendText({
      to: member.phone,
      text:
        `📊 *Your Monthly Summary*\n\n` +
        `Wallet balance: ${formatBalance(member.wallet?.balance ?? 0)}\n` +
        `Saved this month: ${formatBalance(totalSaved)}\n` +
        `Total saved: ${formatBalance(member.wallet?.totalSaved ?? 0)}\n` +
        (activeLoan
          ? `Active loan: ${formatBalance(loanBalance)} remaining\n`
          : `No active loans\n`) +
        `\nReply *menu* to see all options.`,
    });
    sent++;
  }

  return sent;
}

/**
 * Run all proactive alerts for a cooperative.
 */
export async function runAllAlerts(cooperativeId: string) {
  const [savings, loans, overdue, lowBalance, trends, summaries] = await Promise.all([
    sendSavingsReminders(cooperativeId),
    sendLoanReminders(cooperativeId),
    sendOverdueAlerts(cooperativeId),
    sendLowBalanceWarnings(cooperativeId),
    sendTrendAlerts(cooperativeId),
    sendMonthlySummaries(cooperativeId),
  ]);

  return {
    savingsReminders: savings,
    loanReminders: loans,
    overdueAlerts: overdue,
    lowBalanceWarnings: lowBalance,
    trendAlerts: trends,
    monthlySummaries: summaries,
    total: savings + loans + overdue + lowBalance + trends + summaries,
  };
}
