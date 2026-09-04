import { prisma } from "../../lib/prisma.js";
import { sendText } from "../../lib/messaging.js";
import {
  formatBalance,
  getMemberByPhone,
} from "../cooperative.js";
import { provisionVirtualAccount } from "../payments/topup.js";
import { setAutoSave } from "../scheduler.js";
import { joinUnit } from "../units.js";
import { withdrawLimit, canWithdraw } from "../withdrawals.js";
import { computeDividendPreview } from "../dividends.js";
import { getQueuePosition } from "../loans.js";
import { issueSecretChallenge, parseNaira } from "./session.js";

export async function handleBalance(
  phone: string,
  member: { id: string; name: string; cooperative: { name: string }; wallet: { balance: number } | null } | null,
): Promise<void> {
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
    return;
  }
  const balance = member.wallet?.balance ?? 0;
  const [loan] = await prisma.loan.findMany({
    where: { memberId: member.id, status: { in: ["disbursed", "partial"] } },
    select: { amount: true, balance: true },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  const loanText = loan && loan.balance > 0 ? `\n\n📚 Outstanding loan balance: *${formatBalance(loan.balance)}*.` : "";
  await sendText({
    to: phone,
    text: `Hi *${member.name}*, your savings balance is *${formatBalance(balance)}*.\n\nReply *save <amount>* to contribute more.\nReply *menu* to see other options.${loanText}`,
  });
}

export async function handleSave(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
    return;
  }

  let amount: number | null = null;
  if (args[0]) {
    amount = parseNaira(args[0]);
    if (amount === null) {
      await sendText({ to: phone, text: "Please enter a valid amount, e.g. *save 2000*." });
      return;
    }
  }

  // Savings are only credited after a REAL payment arrives via the provider
  // webhook (Monnify/Paystack). We never fabricate a wallet credit here —
  // instead we hand the member their personal funding account and let the
  // confirmed transfer credit the wallet automatically (see topup.ts).
  const fund = await provisionVirtualAccount(member.id);
  const amountLine = amount
    ? `To save *${formatBalance(amount)}*, transfer that exact amount to your funding account below — your wallet is credited automatically once the transfer is confirmed.`
    : `Transfer any amount to your funding account below — your wallet is credited automatically once the transfer is confirmed.`;

  const accountLine = fund.ok
    ? fund.message
    : "We couldn't set up your funding account right now. Please try *fund* again later.";

  await sendText({
    to: phone,
    text: `${amountLine}\n\n${accountLine}\n\nReply *menu* to see other options.`,
  });
}

export async function handleFund(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
    return;
  }
  const result = await provisionVirtualAccount(member.id);
  await sendText({ to: phone, text: result.message });
}

export async function handleWithdraw(phone: string, args: string[]): Promise<void> {
  const amount = parseNaira(args[0]);
  if (amount === null) {
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "awaiting_withdraw_amount" },
      update: { state: "awaiting_withdraw_amount" },
    });
    await sendText({
      to: phone,
      text: "How much would you like to withdraw? You can take out up to *45%* of your savings at once (e.g. *withdraw 5000*).",
    });
    return;
  }
  const limit = await withdrawLimit(phone);
  if (!limit) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
    return;
  }
  const eligibility = await canWithdraw(phone);
  if (!eligibility.ok) {
    await sendText({ to: phone, text: eligibility.message });
    return;
  }
  if (amount > limit.max) {
    await sendText({
      to: phone,
      text: `You can withdraw at most *${formatBalance(limit.max)}* (45% of your ${formatBalance(limit.balance)} balance).`,
    });
    return;
  }
  const member = await getMemberByPhone(phone);
  if (member?.bankAccountNumber && member.bankCode) {
    await issueSecretChallenge(
      phone,
      "awaiting_withdraw_pin",
      { withdrawAmount: amount },
      `Withdraw ${formatBalance(amount)} to ${member.bankName ?? member.bankCode} ****${member.bankAccountNumber.slice(-4)}? Enter your 4-digit PIN to confirm.`,
    );
    return;
  }
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_withdraw_account", data: JSON.stringify({ withdrawAmount: amount }) },
    update: { state: "awaiting_withdraw_account", data: JSON.stringify({ withdrawAmount: amount }) },
  });
  await sendText({
    to: phone,
    text: "Your savings will go to your bank account. What's your *bank account number*? (10 digits, e.g. *0123456789*)",
  });
}

export async function handleLoan(phone: string, args: string[]): Promise<void> {
  const amount = parseNaira(args[0]);
  const months = args[1] ? parseInt(args[1], 10) : NaN;
  if (amount === null) {
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "awaiting_loan_amount" },
      update: { state: "awaiting_loan_amount" },
    });
    await sendText({ to: phone, text: "How much would you like to borrow? (e.g. *50000*)" });
    return;
  }
  if (!Number.isFinite(months) || months < 1 || months > 12) {
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "awaiting_loan_months", data: JSON.stringify({ loanAmount: amount }) },
      update: { state: "awaiting_loan_months", data: JSON.stringify({ loanAmount: amount }) },
    });
    await sendText({ to: phone, text: "For how many months? (1–12)" });
    return;
  }
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_loan_bank_account", data: JSON.stringify({ loanAmount: amount, loanMonths: months }) },
    update: { state: "awaiting_loan_bank_account", data: JSON.stringify({ loanAmount: amount, loanMonths: months }) },
  });
  await sendText({
    to: phone,
    text:
      `Great. The loan will be paid directly into your bank account.\n\n` +
      `What's your *bank account number*? (10 digits, e.g. *0123456789*)`,
  });
}

export async function handleRepay(phone: string, _args: string[]): Promise<void> {
  // Loan repayment is a money-out — require the member's PIN before any debit.
  await issueSecretChallenge(
    phone,
    "awaiting_repay_pin",
    {},
    "Enter your 4-digit PIN to confirm the loan repayment.",
  );
}

export async function handlePlan(phone: string, args: string[]): Promise<void> {
  if (args[0]?.toLowerCase() === "off") {
    const result = await setAutoSave(phone, null);
    await sendText({ to: phone, text: result.message });
    return;
  }
  const amount = parseNaira(args[0]);
  const interval = args[1]?.toLowerCase();
  if (amount === null || (interval !== "weekly" && interval !== "monthly")) {
    await sendText({
      to: phone,
      text: "Usage: *plan <amount> <weekly|monthly>*, e.g. *plan 2000 weekly*. Or *plan off* to stop.",
    });
    return;
  }
  const result = await setAutoSave(phone, amount, interval);
  await sendText({ to: phone, text: result.message });
}

export async function handleDividend(phone: string, args: string[]): Promise<void> {
  // rate is a PERCENTAGE (0-100), NOT a kobo amount — parse it raw, do not
  // route through parseNaira (which converts naira -> kobo).
  const raw = args[0] ? args[0].replace(/[,₦\s]/g, "") : "";
  const rate = /^\d+(\.\d{1,2})?$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
    await sendText({ to: phone, text: "Usage: *dividend <rate>*, e.g. *dividend 5* for a 5% dividend calculation." });
    return;
  }
  const result = await computeDividendPreview(phone, rate);
  await sendText({ to: phone, text: result.message });
}

export async function handleJoinUnit(phone: string, args: string[]): Promise<void> {
  if (!args[0]) {
    await sendText({ to: phone, text: "Usage: *joinunit <code>*, e.g. *joinunit LAG01*." });
    return;
  }
  const result = await joinUnit(phone, args[0]);
  await sendText({ to: phone, text: result.message });
}

export async function handleLoanQueue(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
    return;
  }

  const queue = await getQueuePosition(member.id);
  if (!queue) {
    await sendText({
      to: phone,
      text: "You don't have a pending loan application. Reply *loan <amount>* to apply.",
    });
    return;
  }

  const ahead = queue.position - 1;
  const aheadText = ahead === 0 ? "No members ahead of you." : `${ahead} member${ahead > 1 ? "s" : ""} ahead of you.`;

  await sendText({
    to: phone,
    text:
      `📋 *Loan Queue Position*\n\n` +
      `You are *#${queue.position}* in the loan queue. ${aheadText}\n` +
      `Total in queue: *${queue.total}*\n` +
      `Based on current disbursement rate, estimated wait: *${queue.estimatedWait}*.`,
  });
}

export async function handleAnalytics(
  phone: string,
  member: { id: string; name: string; cooperativeId: string; wallet: { balance: number; totalSaved: number } | null } | null,
): Promise<void> {
  const m = member ?? (await getMemberByPhone(phone));
  if (!m) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
    return;
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);

  const [contribs, withdrawalsYtd, loans, daysMember] = await Promise.all([
    prisma.contribution.aggregate({
      where: { memberId: m.id, status: "confirmed", paidAt: { gte: monthStart } },
      _count: true,
      _sum: { amount: true },
    }),
    prisma.withdrawalRequest.count({
      where: { memberId: m.id, status: { in: ["approved", "paid", "disbursed"] }, createdAt: { gte: yearStart } },
    }),
    prisma.loan.aggregate({
      where: { memberId: m.id, status: { in: ["disbursed", "partial"] } },
      _sum: { balance: true },
      _count: true,
    }),
    prisma.member.findUnique({ where: { id: m.id }, select: { createdAt: true } }),
  ]);

  const balance = m.wallet?.balance ?? 0;
  const totalSaved = m.wallet?.totalSaved ?? 0;
  const savedThisMonth = contribs._sum.amount ?? 0;
  const savedThisMonthCount = contribs._count;
  const loanBalance = loans._sum.balance ?? 0;
  const activeLoans = loans._count;
  const tenorDays = daysMember?.createdAt
    ? Math.max(1, Math.floor((Date.now() - daysMember.createdAt.getTime()) / (24 * 60 * 60 * 1000)))
    : 1;
  const monthlyRate = (totalSaved / tenorDays) * (365 / 12);

  const lines: string[] = [
    `📊 *Savings analytics* for *${m.name}*`,
    ``,
    `💰 Current balance: *${formatBalance(balance)}*`,
    `🏦 Total saved (all-time): *${formatBalance(totalSaved)}*`,
    `📅 Saved this month: *${formatBalance(savedThisMonth)}* (${savedThisMonthCount}×)`,
    `📈 Avg monthly save: *${formatBalance(monthlyRate)}*`,
    `📤 Withdrawals this year: *${withdrawalsYtd}*`,
    `📚 Active loans: *${activeLoans}* (balance *${formatBalance(loanBalance)}*)`,
    ``,
    `Reply *history* for your full transaction log, or *menu* for more options.`,
  ];

  await sendText({ to: phone, text: lines.join("\n") });
}
