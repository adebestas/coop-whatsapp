import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { computePnl } from "./ledger.js";
import { getFundBalances } from "./dividends.js";

export interface ReconciliationReport {
  ok: boolean;
  message: string;
  discrepancy: number;
  status: string;
  logId: string;
}

/**
 * Run wallet-bank reconciliation for a cooperative.
 * Compares the sum of all member wallet balances against the cooperative's
 * bank balance (derived from journal postings to assets:bank).
 *
 * Returns a detailed report and logs the result to ReconciliationLog.
 */
export async function runWalletReconciliation(
  cooperativeId: string,
  adminPhone: string,
): Promise<ReconciliationReport> {
  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });
  if (!coop) {
    return { ok: false, message: "Cooperative not found.", discrepancy: 0, status: "error", logId: "" };
  }

  // 1. Sum of all wallet balances for this cooperative
  const walletAggregate = await prisma.wallet.aggregate({
    where: { member: { cooperativeId, status: "active" } },
    _sum: { balance: true },
  });
  const totalWalletBalances = walletAggregate._sum.balance ?? 0;

  // 2. Bank balance from journal postings (assets:bank account)
  // Bank balance = sum of DEBIT postings to assets:bank - sum of CREDIT postings to assets:bank
  const bankPostings = await prisma.posting.groupBy({
    by: ["direction"],
    where: {
      entry: { cooperativeId },
      account: "assets:bank",
    },
    _sum: { amount: true },
  });
  const bankDebits = bankPostings.find((r) => r.direction === "DEBIT")?._sum.amount ?? 0;
  const bankCredits = bankPostings.find((r) => r.direction === "CREDIT")?._sum.amount ?? 0;
  const bankBalance = bankDebits - bankCredits;

  // 3. Calculate expected balance: member wallets + statutory funds
  const funds = await getFundBalances(cooperativeId);
  const statutoryFunds = funds.reserve + funds.education + funds.development;
  const expectedBalance = totalWalletBalances + statutoryFunds;

  // 4. Calculate discrepancy
  const discrepancy = bankBalance - expectedBalance;

  // 4. Determine status
  let status: string;
  if (discrepancy === 0) {
    status = "ok";
  } else {
    status = "discrepancy";
  }

  // 5. Gather additional stats
  const memberCount = await prisma.member.count({
    where: { cooperativeId, status: "active" },
  });

  const activeLoans = await prisma.loan.findMany({
    where: {
      cooperativeId,
      status: { in: ["approved", "disbursed"] },
    },
    select: { amount: true },
  });
  const activeLoanCount = activeLoans.length;
  const activeLoanTotal = activeLoans.reduce((sum, l) => sum + l.amount, 0);

  const pendingWithdrawals = await prisma.withdrawalRequest.findMany({
    where: {
      cooperativeId,
      status: { in: ["pending", "admin_approved"] },
    },
    select: { amount: true },
  });
  const pendingWithdrawalCount = pendingWithdrawals.length;
  const pendingWithdrawalTotal = pendingWithdrawals.reduce((sum, w) => sum + w.amount, 0);

  // 6. Find last reconciliation
  const lastLog = await prisma.reconciliationLog.findFirst({
    where: { cooperativeId },
    orderBy: { createdAt: "desc" },
  });

  // 7. Log the reconciliation
  const log = await prisma.reconciliationLog.create({
    data: {
      cooperativeId,
      totalWalletBalances,
      bankBalance,
      discrepancy,
      status,
      performedBy: adminPhone,
      memberCount,
      activeLoans: activeLoanCount,
      activeLoanTotal,
      pendingWithdrawals: pendingWithdrawalCount,
      pendingWithdrawalTotal,
    },
  });

  // 8. Build report message
  const date = new Date().toLocaleDateString("en-NG", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const lines: string[] = [];
  lines.push(`📊 *Reconciliation Report — ${date}*`);
  lines.push("");

  if (discrepancy === 0) {
    lines.push(`Member wallets:      ${formatBalance(totalWalletBalances)}`);
    lines.push(`Statutory funds:     ${formatBalance(statutoryFunds)} (reserve ${formatBalance(funds.reserve)} + education ${formatBalance(funds.education)} + development ${formatBalance(funds.development)})`);
    lines.push(`Expected (bank):     ${formatBalance(expectedBalance)}`);
    lines.push(`Actual (bank):       ${formatBalance(bankBalance)}`);
    lines.push(`Discrepancy:         ${formatBalance(0)} ✅`);
  } else {
    lines.push(`⚠️ *DISCREPANCY DETECTED!*`);
    lines.push("");
    lines.push(`Member wallets:      ${formatBalance(totalWalletBalances)}`);
    lines.push(`Statutory funds:     ${formatBalance(statutoryFunds)}`);
    lines.push(`Expected total:      ${formatBalance(expectedBalance)}`);
    lines.push(`Actual (bank):       ${formatBalance(bankBalance)}`);
    lines.push(`Gap:                 ${formatBalance(Math.abs(discrepancy))}`);
    lines.push("");
    lines.push("*Possible causes:*");
    lines.push("- Unrecorded transactions");
    lines.push("- Rounding errors");
    lines.push("- Unauthorized debits");
    lines.push("");
    lines.push("_Action required: Investigate immediately._");
  }

  lines.push("");
  lines.push(`Member count: ${memberCount}`);
  lines.push(`Active loans: ${activeLoanCount} (${formatBalance(activeLoanTotal)} disbursed)`);
  lines.push(`Pending withdrawals: ${pendingWithdrawalCount} (${formatBalance(pendingWithdrawalTotal)})`);

  if (lastLog) {
    const daysAgo = Math.floor(
      (Date.now() - lastLog.createdAt.getTime()) / (24 * 60 * 60 * 1000),
    );
    lines.push("");
    lines.push(
      `Last reconciliation: ${lastLog.createdAt.toISOString().slice(0, 10)} (${daysAgo === 0 ? "today" : `${daysAgo} day${daysAgo > 1 ? "s" : ""} ago`})`,
    );
  }

  return {
    ok: true,
    message: lines.join("\n"),
    discrepancy,
    status,
    logId: log.id,
  };
}

// ---- Fund segregation ----

/** Sum of all "member" fundType ledger entries (member trust fund). */
export async function getMemberFundBalance(cooperativeId: string): Promise<number> {
  const result = await prisma.ledgerEntry.aggregate({
    where: { cooperativeId, fundType: "member" },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

/** Sum of all "operational" fundType ledger entries (cooperative operating funds). */
export async function getOperationalFundBalance(cooperativeId: string): Promise<number> {
  const result = await prisma.ledgerEntry.aggregate({
    where: { cooperativeId, fundType: "operational" },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

/** Sum of all "reserve" fundType ledger entries (statutory reserve). */
export async function getReserveFundBalance(cooperativeId: string): Promise<number> {
  const result = await prisma.ledgerEntry.aggregate({
    where: { cooperativeId, fundType: "reserve" },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

/** Threshold: alert if operational fund exceeds 15% of total. */
const OPERATIONAL_THRESHOLD_PCT = 15;

/**
 * Formatted fund segregation report showing the breakdown of member trust,
 * operational, and reserve funds with percentage allocation and alerts.
 */
export async function getSegregationReport(cooperativeId: string): Promise<string> {
  const [memberFund, operationalFund, reserveFund] = await Promise.all([
    getMemberFundBalance(cooperativeId),
    getOperationalFundBalance(cooperativeId),
    getReserveFundBalance(cooperativeId),
  ]);

  const total = memberFund + operationalFund + reserveFund;

  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

  const lines: string[] = [];
  lines.push(`📊 *Fund Segregation Report*`);
  lines.push(``);
  lines.push(`Member Trust Fund:    ${formatBalance(memberFund)} (${pct(memberFund)}%)`);
  lines.push(`Operational Fund:     ${formatBalance(operationalFund)} (${pct(operationalFund)}%)`);
  lines.push(`Reserve Fund:         ${formatBalance(reserveFund)} (${pct(reserveFund)}%)`);
  lines.push(`Total:                ${formatBalance(total)}`);

  // Alert if operational fund exceeds threshold
  if (total > 0 && pct(operationalFund) > OPERATIONAL_THRESHOLD_PCT) {
    lines.push(``);
    lines.push(`⚠️ *Alert*: Operational fund exceeds ${OPERATIONAL_THRESHOLD_PCT}% threshold (${pct(operationalFund)}%). Consider transferring excess to reserve or distributing as dividend.`);
  }

  return lines.join("\n");
}

/** List of all reserve fund allocations for a cooperative, newest first. */
export async function getReserveHistory(cooperativeId: string) {
  return prisma.reserveAllocation.findMany({
    where: { cooperativeId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

/**
 * Formatted statutory reserve fund report showing balance, allocation history,
 * and compliance status.
 */
export async function getReserveReport(cooperativeId: string): Promise<string> {
  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });
  if (!coop) return "Cooperative not found.";

  const currentBalance = coop.reserveFundBalance;
  const allocations = await getReserveHistory(cooperativeId);
  const totalAllocated = allocations.reduce((sum, a) => sum + a.amount, 0);

  // Compute net profit for compliance check
  const pnl = await computePnl(cooperativeId);
  const netProfit = pnl.netProfit;
  const requiredReserve = Math.floor(Math.max(0, netProfit) * 0.20);
  const isCompliant = netProfit <= 0 || currentBalance >= requiredReserve;

  const lastAlloc = allocations[0];

  const lines: string[] = [];
  lines.push(`📊 *Statutory Reserve Fund Report*`);
  lines.push(``);
  lines.push(`Current balance:    ${formatBalance(currentBalance)}`);
  lines.push(`Total allocated:    ${formatBalance(totalAllocated)}`);

  if (lastAlloc) {
    const date = lastAlloc.createdAt.toISOString().slice(0, 10);
    const ref = lastAlloc.referenceId ? ` (batch ${lastAlloc.referenceId})` : "";
    lines.push(`Last allocation:    ${date} (${formatBalance(lastAlloc.amount)} from ${lastAlloc.source}${ref})`);
  } else {
    lines.push(`Last allocation:    (none yet)`);
  }

  lines.push(``);
  if (netProfit > 0) {
    lines.push(`Net profit:         ${formatBalance(netProfit)}`);
    lines.push(`Required (20%):     ${formatBalance(requiredReserve)}`);
    lines.push(``);
    lines.push(`Status: ${isCompliant ? "✅ Compliant (reserve >= 20% of net profit)" : "⚠️ Below minimum — reserve < 20% of net profit"}`);
  } else {
    lines.push(`Status: ✅ No profit yet — reserve requirement not applicable`);
  }

  if (allocations.length > 1) {
    lines.push(``);
    lines.push(`*Recent allocations:*`);
    for (const a of allocations.slice(0, 5)) {
      const date = a.createdAt.toISOString().slice(0, 10);
      const ref = a.referenceId ? ` (${a.referenceId})` : "";
      lines.push(`• ${date} — ${formatBalance(a.amount)} from ${a.source}${ref}`);
    }
  }

  return lines.join("\n");
}
