import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { getCoopConfig } from "./coop-config.js";

// ===== AML/STR Constants =====

/** Single transaction above this amount (kobo) triggers a large-transaction alert. */
export const LARGE_TX_THRESHOLD = 500_000_000; // ₦5,000,000

/** Maximum number of money-out transactions within the rapid-sequence window. */
export const RAPID_SEQUENCE_MAX = 3;
/** Window (ms) for rapid-sequence detection — 10 minutes. */
export const RAPID_SEQUENCE_WINDOW_MS = 10 * 60 * 1000;

/** Minimum number of round-number transactions within the pattern window. */
export const ROUND_NUMBER_MIN_COUNT = 2;
/** Window (ms) for round-number pattern detection — 24 hours. */
export const ROUND_NUMBER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Percentage of the reporting threshold that constitutes structuring (e.g. 0.96 = within 4%). */
export const STRUCTURING_RATIO = 0.96;
/** Reporting threshold in kobo used for structuring detection (₦5,000,000). */
export const REPORTING_THRESHOLD = 500_000_000;

// ===== Types =====

export interface FlagResult {
  flagged: boolean;
  reasons: string[];
}

export interface TransactionDetail {
  id?: string;
  memberId: string;
  cooperativeId: string;
  amount: number;
  type: string; // 'withdrawal' | 'payout' | 'loan_disbursement' | 'contribution'
  direction: "in" | "out";
  createdAt?: Date;
}

export interface STRReport {
  memberName: string;
  memberPhone: string;
  cooperativeName: string;
  transactions: TransactionDetail[];
  reasons: string[];
  timestamp: string;
  summary: string;
}

// ===== Monitoring Rules =====

/**
 * Rule 1: Large transaction alert — any single transaction above the cooperative's threshold.
 */
function checkLargeTransaction(amount: number, largeTxThreshold: number): string | null {
  if (amount > largeTxThreshold) {
    return `Large transaction: ${formatBalance(amount)} exceeds ${formatBalance(largeTxThreshold)} threshold`;
  }
  return null;
}

/**
 * Rule 2: Rapid sequence — 3+ money-out transactions within 10 minutes from the same member.
 */
async function checkRapidSequence(memberId: string, direction: "in" | "out", excludeId?: string): Promise<string | null> {
  if (direction !== "out") return null;

  const since = new Date(Date.now() - RAPID_SEQUENCE_WINDOW_MS);
  const where: any = {
    memberId,
    createdAt: { gte: since },
    status: { in: ["paid", "successful", "approved", "processing"] },
  };
  if (excludeId) {
    where.id = { not: excludeId };
  }

  const [withdrawals, payouts] = await Promise.all([
    prisma.withdrawalRequest.aggregate({
      where: { ...where, status: { in: ["paid"] } },
      _count: { id: true },
    }),
    prisma.payout.aggregate({
      where: { ...where, status: "successful" },
      _count: { id: true },
    }),
  ]);

  const count = (withdrawals._count.id ?? 0) + (payouts._count.id ?? 0);
  if (count >= RAPID_SEQUENCE_MAX) {
    return `Rapid sequence: ${count} money-out transactions within ${RAPID_SEQUENCE_WINDOW_MS / 60000} minutes`;
  }
  return null;
}

/**
 * Rule 3: Round number pattern — multiple round-number transactions within 24 hours.
 */
async function checkRoundNumberPattern(memberId: string, cooperativeId: string): Promise<string | null> {
  const since = new Date(Date.now() - ROUND_NUMBER_WINDOW_MS);

  const [withdrawals, payouts] = await Promise.all([
    prisma.withdrawalRequest.findMany({
      where: {
        memberId,
        status: "paid",
        createdAt: { gte: since },
      },
      select: { amount: true },
    }),
    prisma.payout.findMany({
      where: {
        memberId,
        cooperativeId,
        status: "successful",
        createdAt: { gte: since },
      },
      select: { amount: true },
    }),
  ]);

  const all = [...withdrawals, ...payouts];
  const roundNumbers = all.filter((tx) => {
    const amount = tx.amount;
    // Round to nearest 10,000 kobo (₦100)
    return amount >= 100_000 && amount % 100_000 === 0;
  });

  if (roundNumbers.length >= ROUND_NUMBER_MIN_COUNT) {
    const amounts = roundNumbers.map((r) => formatBalance(r.amount)).join(", ");
    return `Round-number pattern: ${roundNumbers.length} round transactions in 24h (${amounts})`;
  }
  return null;
}

/**
 * Rule 4: Structuring detection — transactions just below the reporting threshold.
 */
async function checkStructuring(memberId: string, cooperativeId: string, reportingThreshold: number): Promise<string | null> {
  const since = new Date(Date.now() - ROUND_NUMBER_WINDOW_MS);
  const minAmount = Math.floor(reportingThreshold * STRUCTURING_RATIO);

  const [withdrawals, payouts] = await Promise.all([
    prisma.withdrawalRequest.findMany({
      where: {
        memberId,
        status: "paid",
        createdAt: { gte: since },
        amount: { gte: minAmount, lt: reportingThreshold },
      },
      select: { amount: true, createdAt: true },
    }),
    prisma.payout.findMany({
      where: {
        memberId,
        cooperativeId,
        status: "successful",
        createdAt: { gte: since },
        amount: { gte: minAmount, lt: reportingThreshold },
      },
      select: { amount: true, createdAt: true },
    }),
  ]);

  const structuringTx = [...withdrawals, ...payouts];
  if (structuringTx.length >= 2) {
    const amounts = structuringTx.map((s) => formatBalance(s.amount)).join(", ");
    return `Possible structuring: ${structuringTx.length} transactions near ${formatBalance(reportingThreshold)} threshold (${amounts})`;
  }
  return null;
}

// ===== Public API =====

/**
 * Check all AML rules for a transaction and return whether it is flagged.
 */
export async function flagTransaction(tx: TransactionDetail): Promise<FlagResult> {
  const reasons: string[] = [];

  const coopConfig = await getCoopConfig(tx.cooperativeId);
  const largeTxThreshold = coopConfig.largeTxThreshold;
  const reportingThreshold = coopConfig.reportingThreshold;

  const large = checkLargeTransaction(tx.amount, largeTxThreshold);
  if (large) reasons.push(large);

  const rapid = await checkRapidSequence(tx.memberId, tx.direction, tx.id);
  if (rapid) reasons.push(rapid);

  // Only check pattern rules for money-out transactions
  if (tx.direction === "out") {
    const round = await checkRoundNumberPattern(tx.memberId, tx.cooperativeId);
    if (round) reasons.push(round);

    const structuring = await checkStructuring(tx.memberId, tx.cooperativeId, reportingThreshold);
    if (structuring) reasons.push(structuring);
  }

  return { flagged: reasons.length > 0, reasons };
}

/**
 * Generate a Suspicious Transaction Report (STR) summary for a member.
 */
export async function generateSTR(memberPhone: string, cooperativeId: string): Promise<STRReport | null> {
  const member = await prisma.member.findFirst({
    where: { phone: memberPhone, cooperativeId },
    include: { cooperative: true },
  });
  if (!member) return null;

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Last 7 days

  const [withdrawals, payouts] = await Promise.all([
    prisma.withdrawalRequest.findMany({
      where: { memberId: member.id, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.payout.findMany({
      where: { memberId: member.id, cooperativeId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  const allTx: TransactionDetail[] = [
    ...withdrawals.map((w) => ({
      id: w.id,
      memberId: member.id,
      cooperativeId,
      amount: w.amount,
      type: "withdrawal",
      direction: "out" as const,
      createdAt: w.createdAt,
    })),
    ...payouts.map((p) => ({
      id: p.id,
      memberId: member.id,
      cooperativeId,
      amount: p.amount,
      type: "payout",
      direction: "out" as const,
      createdAt: p.createdAt,
    })),
  ];

  // Check each transaction for flags
  const allReasons: string[] = [];
  for (const tx of allTx) {
    const result = await flagTransaction(tx);
    if (result.flagged) {
      allReasons.push(...result.reasons);
    }
  }

  const uniqueReasons = [...new Set(allReasons)];

  const txSummary = allTx
    .slice(0, 10)
    .map(
      (tx) =>
        `  - ${tx.type} ${formatBalance(tx.amount)} (${tx.direction}) on ${tx.createdAt?.toISOString().slice(0, 10) ?? "unknown"}`,
    )
    .join("\n");

  const timestamp = new Date().toISOString();
  const summary =
    `=== SUSPICIOUS TRANSACTION REPORT ===\n` +
    `Date: ${timestamp}\n` +
    `Member: ${member.name} (${member.phone})\n` +
    `Cooperative: ${member.cooperative.name}\n` +
    `Member ID: ${member.id}\n` +
    `Member Code: ${member.code}\n\n` +
    `--- Transactions (last 7 days) ---\n` +
    (txSummary || "  No recent transactions.\n") +
    `\n--- Flagged Reasons ---\n` +
    (uniqueReasons.length > 0 ? uniqueReasons.map((r) => `  - ${r}`).join("\n") : "  None\n");

  return {
    memberName: member.name,
    memberPhone: member.phone,
    cooperativeName: member.cooperative.name,
    transactions: allTx,
    reasons: uniqueReasons,
    timestamp,
    summary,
  };
}

/**
 * Admin command handler for STR: `str <member-phone>`.
 * Returns the formatted STR text for the admin to view.
 */
export async function handleSTR(
  memberPhone: string,
  cooperativeId: string,
): Promise<{ ok: boolean; message: string }> {
  const cleaned = memberPhone.replace(/[^0-9+]/g, "");
  if (!cleaned) {
    return { ok: false, message: "Usage: *str <member-phone>* — e.g. *str 2348012345678*" };
  }

  const str = await generateSTR(cleaned, cooperativeId);
  if (!str) {
    return { ok: false, message: `No member found with phone ${cleaned} in your cooperative.` };
  }

  if (str.reasons.length === 0) {
    return {
      ok: true,
      message:
        `📋 STR for *${str.memberName}* (${str.memberPhone})\n\n` +
        `No suspicious activity detected in the last 7 days.`,
    };
  }

  return {
    ok: true,
    message: str.summary,
  };
}
