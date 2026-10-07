import { prisma } from "../../lib/prisma.js";
import { sendText } from "../../lib/messaging.js";
import { formatBalance, getMemberByPhone } from "../cooperative.js";
import { provisionVirtualAccount } from "../payments/topup.js";
import { setAutoSave } from "../scheduler.js";
import { joinUnit } from "../units.js";
import { withdrawLimit, canWithdraw } from "../withdrawals.js";
import { computeDividendPreview } from "../dividends.js";
import { getQueuePosition } from "../loans.js";
import { getShareAccount } from "../shares.js";
import { applyGroupLoan } from "../groups.js";
import {
  listProducts,
  openProduct,
  depositToProduct,
  withdrawFromProduct,
  matureProduct,
  listMemberProducts,
  openJuniorAccount,
} from "../savings-products.js";
import { listMandates } from "../mandates.js";
import { issueSecretChallenge, parseNaira } from "./session.js";
import { resolveProvider, listBanks, type Bank } from "../payments/index.js";
import { savePayee } from "../../lib/beneficiaries.js";
import type { FlowData } from "../conversation.js";

export async function handleBalance(
  phone: string,
  member: {
    id: string;
    name: string;
    cooperative: { name: string };
    wallet: { balance: number } | null;
  } | null,
): Promise<void> {
  if (!member) {
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>* to get started.",
    });
    return;
  }
  const balance = member.wallet?.balance ?? 0;
  const [loan] = await prisma.loan.findMany({
    where: { memberId: member.id, status: { in: ["disbursed", "partial"] } },
    select: { amount: true, balance: true },
    orderBy: { createdAt: "desc" },
    take: 1,
  });
  const loanText =
    loan && loan.balance > 0
      ? `\n\n📚 Outstanding loan balance: *${formatBalance(loan.balance)}*.`
      : "";
  await sendText({
    to: phone,
    text: `Hi *${member.name}*, your savings balance is *${formatBalance(balance)}*.\n\nReply *save <amount>* to contribute more.\nReply *menu* to see other options.${loanText}`,
  });
}

export async function handleSave(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>* to get started.",
    });
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
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>* to get started.",
    });
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
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>* to get started.",
    });
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
  await startBankFlow(phone, "withdraw", { withdrawAmount: amount });
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
      create: {
        phone,
        state: "awaiting_loan_months",
        data: JSON.stringify({ loanAmount: amount }),
      },
      update: { state: "awaiting_loan_months", data: JSON.stringify({ loanAmount: amount }) },
    });
    await sendText({ to: phone, text: "For how many months? (1–12)" });
    return;
  }
  await prisma.session.upsert({
    where: { phone },
    create: {
      phone,
      state: "awaiting_loan_bank_account",
      data: JSON.stringify({ loanAmount: amount, loanMonths: months }),
    },
    update: {
      state: "awaiting_loan_bank_account",
      data: JSON.stringify({ loanAmount: amount, loanMonths: months }),
    },
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
    await sendText({
      to: phone,
      text: "Usage: *dividend <rate>*, e.g. *dividend 5* for a 5% dividend calculation.",
    });
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
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>* to get started.",
    });
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
  const aheadText =
    ahead === 0
      ? "No members ahead of you."
      : `${ahead} member${ahead > 1 ? "s" : ""} ahead of you.`;

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
  member: {
    id: string;
    name: string;
    cooperativeId: string;
    wallet: { balance: number; totalSaved: number } | null;
  } | null,
): Promise<void> {
  const m = member ?? (await getMemberByPhone(phone));
  if (!m) {
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>* to get started.",
    });
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
      where: {
        memberId: m.id,
        status: { in: ["approved", "paid", "disbursed"] },
        createdAt: { gte: yearStart },
      },
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

export async function handleShares(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const account = await getShareAccount(member.id);
  if (!account) {
    await sendText({ to: phone, text: "We couldn't load your share account. Please try again." });
    return;
  }
  await sendText({
    to: phone,
    text:
      `📈 *Your shares*\n\n` +
      `Shares held: *${account.shares}*\n` +
      `Value: *${formatBalance(account.value)}* (at ${formatBalance(account.pricePerShare)}/share)\n` +
      `Total paid: *${formatBalance(account.totalPaid)}*\n\n` +
      `Reply *buyshares <count>* to buy more.`,
  });
}

export async function handleBuyShares(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const count = args[0] ? parseInt(args[0], 10) : NaN;
  if (!Number.isInteger(count) || count <= 0) {
    await sendText({ to: phone, text: "How many shares? Reply *buyshares <count>*, e.g. *buyshares 5*." });
    return;
  }
  await issueSecretChallenge(
    phone,
    "awaiting_buyshares_pin",
    { shareCount: count },
    `Buy *${count}* share(s)? Enter your 4-digit PIN to confirm.`,
  );
}

export async function handleGroupLoan(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const groupId = args[0];
  const amount = parseNaira(args[1]);
  const months = args[2] ? parseInt(args[2], 10) : NaN;
  if (!groupId || amount === null || !Number.isInteger(months) || months < 1) {
    await sendText({
      to: phone,
      text: "Usage: *grouploan <group id> <amount> <months>* — e.g. *grouploan abc123 50000 3*",
    });
    return;
  }
  const applied = await applyGroupLoan(member.cooperativeId, groupId, member.id, amount, months);
  await sendText({ to: phone, text: applied.message });
}

/** Browse the cooperative's savings products. */
export async function handleProducts(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const listed = await listProducts(member.cooperativeId);
  const active = (listed.products ?? []).filter((p) => p.active);
  if (active.length === 0) {
    await sendText({
      to: phone,
      text: "No savings products yet. Ask your cooperative admin to create one.",
    });
    return;
  }
  const lines = ["*🏦 Savings Products*", ""];
  for (const p of active) {
    const meta = [
      p.termMonths ? `${p.termMonths} months` : null,
      p.interestRate ? `${p.interestRate}% at maturity` : null,
      p.minAmount ? `${formatBalance(p.minAmount)} min` : null,
    ]
      .filter(Boolean)
      .join(" — ");
    lines.push(
      `• *${p.name}* (${p.type.toUpperCase()})${meta ? ` — ${meta}` : ""}`,
      `  Open with *openproduct ${p.id}${p.type === "goal" ? " <target>" : ""}*`,
    );
  }
  await sendText({ to: phone, text: lines.join("\n") });
}

/** Open a savings account against a product, optionally with a goal target. */
export async function handleOpenProduct(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const productId = args[0];
  if (!productId) {
    await sendText({
      to: phone,
      text: "Usage: *openproduct <product id> [target]* — browse products with *products*.",
    });
    return;
  }
  const target = args[1] ? parseNaira(args[1]) : null;
  const opened = await openProduct(
    member.cooperativeId,
    productId,
    member.id,
    target === null ? undefined : target,
  );
  await sendText({ to: phone, text: opened.message });
}

/** Open a guardian-managed junior savings account for a minor. */
export async function handleOpenJunior(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const productId = args[0];
  const rest = args.slice(1);
  // The optional trailing token is a phone number; everything before it is the
  // minor's (possibly multi-word) name.
  const last = rest[rest.length - 1] ?? "";
  const hasPhone = rest.length > 1 && /^[+0-9][0-9]{6,}$/.test(last);
  const minorName = (hasPhone ? rest.slice(0, -1) : rest).join(" ").trim();
  const minorPhone = hasPhone ? last : undefined;
  if (!productId || !minorName) {
    await sendText({
      to: phone,
      text: "Usage: *openjunior <product id> <minor name> [minor phone]* — browse products with *products*.",
    });
    return;
  }
  const opened = await openJuniorAccount(
    member.cooperativeId,
    productId,
    member.id,
    minorName,
    minorPhone,
  );
  await sendText({ to: phone, text: opened.message });
}

/** Deposit wallet funds into a savings account. */
export async function handleSaveProduct(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const accountId = args[0];
  const amount = parseNaira(args[1]);
  if (!accountId || amount === null) {
    await sendText({
      to: phone,
      text: "Usage: *saveproduct <account id> <amount>* — e.g. *saveproduct abc123 5000*.",
    });
    return;
  }
  const result = await depositToProduct(member.cooperativeId, accountId, member.id, amount);
  await sendText({ to: phone, text: result.message });
}

/** Withdraw from a savings account back into the wallet. */
export async function handleWithdrawProduct(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const accountId = args[0];
  const amount = parseNaira(args[1]);
  if (!accountId || amount === null) {
    await sendText({
      to: phone,
      text: "Usage: *withdrawproduct <account id> <amount>* — e.g. *withdrawproduct abc123 5000*.",
    });
    return;
  }
  const result = await withdrawFromProduct(member.cooperativeId, accountId, member.id, amount);
  await sendText({ to: phone, text: result.message });
}

/** List a member's product savings accounts. */
export async function handleMyProducts(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const mine = await listMemberProducts(member.cooperativeId, member.id);
  if (!mine.accounts || mine.accounts.length === 0) {
    await sendText({
      to: phone,
      text: "You have no product savings yet. Browse *products* and open one with *openproduct <id>*.",
    });
    return;
  }
  const lines = ["*🏦 Your Savings Products*", ""];
  for (const a of mine.accounts) {
    const target = a.targetAmount
      ? ` — ${formatBalance(a.balance)} of ${formatBalance(a.targetAmount)} (${a.progress.percent}%)`
      : ` — ${formatBalance(a.balance)}`;
    const maturity = a.maturesAt ? ` — matures ${a.maturesAt.toDateString()}` : "";
    lines.push(
      `• *${a.productName}* (${a.type.toUpperCase()})${target} — _${a.status}_${maturity}`,
      `  ID: ${a.id}`,
    );
  }
  await sendText({ to: phone, text: lines.join("\n") });
}

/** Mature a term deposit (or complete an open goal) and credit the wallet. */
export async function handleMatureProduct(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const accountId = args[0];
  if (!accountId) {
    await sendText({ to: phone, text: "Usage: *matureproduct <account id>*." });
    return;
  }
  const result = await matureProduct(member.cooperativeId, accountId, member.id);
  await sendText({ to: phone, text: result.message });
}

/** Start a direct-debit mandate: PIN-confirmed, then returns the provider link. */
export async function handleMandate(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const cap = parseNaira(args[0]);
  if (cap === null) {
    await sendText({
      to: phone,
      text: "How much should we be able to collect at most each time? Reply *mandate <amount>*, e.g. *mandate 5000*.",
    });
    return;
  }
  // Guided account entry: account number -> bank list -> name confirm -> PIN.
  await startBankFlow(phone, "mandate", { mandateCap: cap });
}

/** List the member's direct-debit mandates. */
export async function handleMandates(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const listed = await listMandates(member.cooperativeId, member.id);
  if (!listed.mandates || listed.mandates.length === 0) {
    await sendText({
      to: phone,
      text: "You have no direct-debit mandates. Set one up with *mandate <cap>*, e.g. *mandate 5000*.",
    });
    return;
  }
  const lines = ["*🔁 Your Direct-Debit Mandates*", ""];
  for (const m of listed.mandates) {
    const paused = m.pausedPurposes ? ` — paused: ${m.pausedPurposes}` : "";
    lines.push(
      `• _${m.status}_ — up to *${formatBalance(m.amountCap)}*/debit`,
      `  ${m.provider} • bank ****${m.bankAccountNumber.slice(-4)}${paused}`,
      `  ID: ${m.id}`,
    );
  }
  await sendText({ to: phone, text: lines.join("\n") });
}

/** Show one mandate's details. */
export async function handleMandateStatus(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const idRef = args[0];
  if (!idRef) {
    await sendText({ to: phone, text: "Usage: *mandatestatus <mandate id>* — list them with *mandates*." });
    return;
  }
  const listed = await listMandates(member.cooperativeId, member.id);
  const mandate = listed.mandates?.find(
    (m) => m.id === idRef || m.id.startsWith(idRef) || m.id.endsWith(idRef),
  );
  if (!mandate) {
    await sendText({ to: phone, text: "Mandate not found. Reply *mandates* to see your list." });
    return;
  }
  const authorized = mandate.authorizedAt
    ? mandate.authorizedAt.toDateString()
    : "not authorized yet";
  const cancelled = mandate.cancelledAt ? mandate.cancelledAt.toDateString() : "—";
  const link = mandate.authorizationUrl ? `\n• Authorize: ${mandate.authorizationUrl}` : "";
  const paused = mandate.pausedPurposes ? `\n• Paused purposes: *${mandate.pausedPurposes}*` : "";
  await sendText({
    to: phone,
    text:
      `*🔁 Mandate ${mandate.id}*\n\n` +
      `• Status: *${mandate.status}*\n` +
      `• Cap: *${formatBalance(mandate.amountCap)}*/debit\n` +
      `• Provider: ${mandate.provider}\n` +
      `• Bank: ${mandate.bankName ?? mandate.bankCode} ****${mandate.bankAccountNumber.slice(-4)}\n` +
      `• Authorized: ${authorized}\n` +
      `• Cancelled: ${cancelled}${link}${paused}\n\n` +
      `Reply *cancelmandate ${mandate.id}* to stop it.`,
  });
}

/** Cancel a mandate: PIN-confirmed. */
export async function handleCancelMandate(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const mandateId = args[0];
  if (!mandateId) {
    await sendText({
      to: phone,
      text: "Usage: *cancelmandate <mandate id>* — list them with *mandates*.",
    });
    return;
  }
  await issueSecretChallenge(
    phone,
    "awaiting_cancelmandate_pin",
    { mandateId },
    `Cancel mandate *${mandateId}*? No further debits will be collected. Enter your 4-digit PIN to confirm.`,
  );
}

// ===== Guided bank-account entry (used by the mandate, withdrawal and payee flows) =====

/** Persist a session state + data payload. */
async function setSession(phone: string, state: string, data: FlowData): Promise<void> {
  await prisma.session.upsert({
    where: { phone },
    create: { phone, state, data: JSON.stringify(data) },
    update: { state, data: JSON.stringify(data) },
  });
}

function bankListText(banks: Bank[]): string {
  const lines = banks.map((b, i) => `${i + 1}. ${b.name}`);
  return (
    "Which bank is this account with? Reply with the *number* or type the *bank name*.\n\n" +
    lines.join("\n")
  );
}

/** Match a reply (list number, raw bank code, or a name substring) against the list. */
function matchBank(banks: Bank[], input: string): Bank | null {
  const q = input.trim().toLowerCase();
  if (!q) return null;
  if (/^\d+$/.test(q)) {
    const idx = parseInt(q, 10);
    if (idx >= 1 && idx <= banks.length) return banks[idx - 1];
    return banks.find((b) => b.code === q) ?? null;
  }
  return banks.find((b) => b.name.toLowerCase().includes(q) || b.code === q) ?? null;
}

/** Fetch the bank list (cached, static fallback) and ask the member to pick one. */
async function showBankList(phone: string, data: FlowData): Promise<void> {
  const provider = await resolveProvider();
  const banks = await listBanks(provider);
  await setSession(phone, "awaiting_bank_choice", { ...data, bankChoices: banks });
  await sendText({ to: phone, text: bankListText(banks) });
}

/**
 * Start the guided account-entry flow. When the account number is already known
 * (e.g. `addpayee <name> <account>`) it jumps straight to the bank list.
 */
export async function startBankFlow(
  phone: string,
  intent: "mandate" | "withdraw" | "payee",
  data: FlowData,
  account?: string,
): Promise<void> {
  const base: FlowData = { ...data, bankIntent: intent };
  if (account) {
    await showBankList(phone, { ...base, bankAccount: account });
    return;
  }
  await setSession(phone, "awaiting_bank_account", base);
  await sendText({
    to: phone,
    text: "What's your *bank account number*? (10 digits, e.g. *0123456789*)",
  });
}

/** Step 1: the member typed their account number; list banks and ask them to pick. */
export async function handleBankAccountStep(
  phone: string,
  text: string,
  data: FlowData,
): Promise<void> {
  const account = text.trim().replace(/[^0-9]/g, "");
  if (!/^\d{10}$/.test(account)) {
    await sendText({
      to: phone,
      text: "Account numbers are 10 digits. Please re-enter, e.g. *0123456789*.",
    });
    return;
  }
  await showBankList(phone, { ...data, bankAccount: account });
}

/** Step 2: the member picked a bank; resolve the account name and ask to confirm. */
export async function handleBankChoiceStep(
  phone: string,
  text: string,
  data: FlowData,
): Promise<void> {
  const banks = data.bankChoices ?? [];
  const picked = matchBank(banks, text);
  if (!picked) {
    await sendText({ to: phone, text: `We didn't catch that.\n\n${bankListText(banks)}` });
    return;
  }
  const account = data.bankAccount ?? "";
  const provider = await resolveProvider();
  const resolved = await provider.resolveAccount?.({
    accountNumber: account,
    bankCode: picked.code,
  });
  if (!resolved?.ok || !resolved.name) {
    await sendText({
      to: phone,
      text:
        `We couldn't confirm the account name for *${picked.name}*. Please check the bank and try again.\n\n` +
        bankListText(banks),
    });
    return;
  }
  await setSession(phone, "awaiting_bank_confirm", {
    ...data,
    bankCode: picked.code,
    bankName: picked.name,
    bankAccountName: resolved.name,
  });
  await sendText({
    to: phone,
    text:
      `Bank: *${picked.name}*\n` +
      `Account: ****${account.slice(-4)}\n` +
      `Name on account: *${resolved.name}*\n\n` +
      `Is this correct? Reply *yes* to continue or *cancel* to stop.`,
  });
}

/** Step 3: the member confirmed the resolved name; continue the caller's flow. */
export async function handleBankConfirmStep(
  phone: string,
  text: string,
  data: FlowData,
): Promise<void> {
  const answer = text.trim().toLowerCase();
  if (answer !== "yes" && answer !== "y") {
    await setSession(phone, "idle", {});
    await sendText({ to: phone, text: "Cancelled. Reply *menu* to see options." });
    return;
  }

  if (data.bankIntent === "payee") {
    const member = await getMemberByPhone(phone);
    if (!member) {
      await setSession(phone, "idle", {});
      await sendText({
        to: phone,
        text: "You need to join a cooperative first. Reply *join <code>*.",
      });
      return;
    }
    const result = await savePayee(
      member.id,
      data.payeeName ?? "",
      data.bankAccount ?? "",
      data.bankCode ?? "",
      data.bankName ?? null,
    );
    await setSession(phone, "idle", {});
    await sendText({
      to: phone,
      text: result.ok
        ? `✅ Payee *${result.payee.name}* saved (${data.bankName} ****${(data.bankAccount ?? "").slice(-4)} — ${data.bankAccountName}). Reply *payees* to see your list.`
        : result.message,
    });
    return;
  }

  if (data.bankIntent === "withdraw") {
    await issueSecretChallenge(
      phone,
      "awaiting_withdraw_pin",
      {
        ...data,
        withdrawAccount: data.bankAccount,
        withdrawBankCode: data.bankCode,
        withdrawBankName: data.bankName,
      },
      `Withdraw ${formatBalance(data.withdrawAmount ?? 0)} to ${data.bankName} ****${(data.bankAccount ?? "").slice(-4)}? Enter your 4-digit PIN to confirm.`,
    );
    return;
  }

  // Default: direct-debit mandate — keep the existing PIN step.
  await issueSecretChallenge(
    phone,
    "awaiting_mandate_pin",
    data,
    `Authorize automatic debits of up to *${formatBalance(data.mandateCap ?? 0)}* per collection? Enter your 4-digit PIN to confirm.`,
  );
}

/** Save a favorite payee through the guided bank flow: account -> bank -> confirm. */
export async function handleAddPayee(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const name = args[0];
  const account = (args[1] ?? "").replace(/[^0-9]/g, "");
  if (!name || !/^\d{10}$/.test(account)) {
    await sendText({
      to: phone,
      text: "Usage: *addpayee <name> <account>*, e.g. *addpayee mama-ngozi 0123456789*. We'll confirm the account name.",
    });
    return;
  }
  await startBankFlow(phone, "payee", { payeeName: name }, account);
}
