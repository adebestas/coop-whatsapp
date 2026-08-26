import { prisma } from "../../lib/prisma.js";
import { sendText } from "../../lib/messaging.js";
import {
  createContribution,
  formatBalance,
  getMemberByPhone,
} from "../cooperative.js";
import { provisionVirtualAccount } from "../payments/topup.js";
import { setAutoSave } from "../scheduler.js";
import { joinUnit } from "../units.js";
import { withdrawLimit, requestWithdrawal, canWithdraw } from "../withdrawals.js";
import { computeDividendPreview } from "../dividends.js";
import { applyForLoan, repayLoan, getQueuePosition } from "../loans.js";
import { issueSecretChallenge, parseNaira } from "./session.js";
import { safeParse } from "./session.js";

export async function handleBalance(
  phone: string,
  member: { name: string; cooperative: { name: string }; wallet: { balance: number } | null } | null,
): Promise<void> {
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>* to get started." });
    return;
  }
  const balance = member.wallet?.balance ?? 0;
  await sendText({
    to: phone,
    text: `Hi *${member.name}*, your savings balance is *${formatBalance(balance)}*.\n\nReply *save <amount>* to contribute more.`,
  });
}

export async function handleSave(phone: string, args: string[]): Promise<void> {
  const amount = parseNaira(args[0]);
  if (amount === null) {
    await prisma.session.upsert({
      where: { phone },
      create: { phone, state: "awaiting_save_amount" },
      update: { state: "awaiting_save_amount" },
    });
    await sendText({ to: phone, text: "How much would you like to save? (e.g. *2000*)" });
    return;
  }
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "awaiting_save_confirm", data: JSON.stringify({ saveAmount: amount }) },
    update: { state: "awaiting_save_confirm", data: JSON.stringify({ saveAmount: amount }) },
  });
  await sendText({
    to: phone,
    text: `You're about to save ₦${amount.toLocaleString()}. Reply *yes* to confirm or *menu* to cancel.`,
  });
}

export async function handleFund(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
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
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
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
      `Withdraw ${amount.toLocaleString()} to ${member.bankName ?? member.bankCode} ****${member.bankAccountNumber.slice(-4)}? Enter your 4-digit PIN to confirm.`,
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
  const result = await repayLoan(phone);
  await sendText({ to: phone, text: result.message });
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
  const rate = parseNaira(args[0]);
  if (rate === null) {
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
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
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
