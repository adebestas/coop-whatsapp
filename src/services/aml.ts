import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { getCoopConfig } from "./coop-config.js";
import { notifyMember } from "../lib/messaging.js";

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
async function checkRapidSequence(memberId: string, direction: "in" | "out"): Promise<string | null> {
  if (direction !== "out") return null;

  const since = new Date(Date.now() - RAPID_SEQUENCE_WINDOW_MS);
  const where: any = {
    memberId,
    createdAt: { gte: since },
    status: { in: ["paid", "successful", "approved", "processing"] },
  };

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

/**
 * Rule 5: Deposit structuring — multiple deposits just below the reporting
 * threshold within 24 hours. Money-in structuring can indicate layering
 * (breaking large sums into smaller deposits to avoid detection).
 */
async function checkDepositStructuring(memberId: string, cooperativeId: string, reportingThreshold: number): Promise<string | null> {
  const since = new Date(Date.now() - ROUND_NUMBER_WINDOW_MS);
  const minAmount = Math.floor(reportingThreshold * STRUCTURING_RATIO);

  const contributions = await prisma.contribution.findMany({
    where: {
      memberId,
      cooperativeId,
      status: "confirmed",
      createdAt: { gte: since },
      amount: { gte: minAmount, lt: reportingThreshold },
    },
    select: { amount: true, createdAt: true },
  });

  if (contributions.length >= 2) {
    const amounts = contributions.map((c) => formatBalance(c.amount)).join(", ");
    return `Deposit structuring: ${contributions.length} deposits near ${formatBalance(reportingThreshold)} threshold (${amounts})`;
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

  const rapid = await checkRapidSequence(tx.memberId, tx.direction);
  if (rapid) reasons.push(rapid);

  // Only check pattern rules for money-out transactions
  if (tx.direction === "out") {
    const round = await checkRoundNumberPattern(tx.memberId, tx.cooperativeId);
    if (round) reasons.push(round);

    const structuring = await checkStructuring(tx.memberId, tx.cooperativeId, reportingThreshold);
    if (structuring) reasons.push(structuring);
  }

  // Check deposit structuring for money-in transactions
  if (tx.direction === "in") {
    const depositStructuring = await checkDepositStructuring(tx.memberId, tx.cooperativeId, reportingThreshold);
    if (depositStructuring) reasons.push(depositStructuring);
  }

  // CBN ₦5M threshold: check aggregate outflow within 24 hours
  if (tx.direction === "out") {
    const agg = await checkAggregateThreshold(tx.memberId, tx.cooperativeId, reportingThreshold);
    if (agg.exceeds) {
      const aggReason = `Aggregate outflow ₦${(agg.total / 100).toLocaleString()} in 24h exceeds ₦5,000,000 CBN threshold`;
      reasons.push(aggReason);
      await autoFileSTR(tx, aggReason);
    }
  }

  // Auto-file STR for single large transactions at or above ₦5,000,000
  if (tx.amount >= REPORTING_THRESHOLD) {
    const singleReason = `Single transaction ${formatBalance(tx.amount)} meets CBN ₦5,000,000 STR threshold`;
    reasons.push(singleReason);
    await autoFileSTR(tx, singleReason);
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

/**
 * Auto-file an STR with the CBN when a transaction meets or exceeds the
 * ₦5,000,000 threshold — single transaction or aggregate within 24 hours.
 * Creates a pending STR record and notifies the cooperative super admin.
 */
export async function autoFileSTR(
  tx: TransactionDetail,
  reason: string,
): Promise<{ filed: boolean; strId?: string }> {
  try {
    // Prevent duplicate STR for the same member on the same day
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const existing = await prisma.sTR.findFirst({
      where: {
        memberId: tx.memberId,
        cooperativeId: tx.cooperativeId,
        createdAt: { gte: todayStart },
      },
    });
    if (existing) return { filed: false };

    // Attempt automated STR filing with the CBN via an optional webhook.
    // CBN requires filing within 72 hours of detection. If CBN_STR_WEBHOOK is
    // not configured, the report is created as PENDING and super admins are
    // notified to file manually within the 72-hour deadline.
    const str = await prisma.sTR.create({
      data: {
        cooperativeId: tx.cooperativeId,
        memberId: tx.memberId,
        amount: tx.amount,
        reason,
        status: "pending",
      },
    });

    const payload = {
      strId: str.id,
      cooperativeId: tx.cooperativeId,
      memberId: tx.memberId,
      amount: tx.amount,
      currency: "NGN",
      reason,
      detectedAt: new Date().toISOString(),
      reportingEntity: process.env.COOP_NAME ?? "Cooperative",
    };

    let autoFiled = false;
    const cbnWebhook = process.env.CBN_STR_WEBHOOK;
    if (cbnWebhook) {
      try {
        const resp = await fetch(cbnWebhook, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(process.env.CBN_STR_TOKEN ? { Authorization: `Bearer ${process.env.CBN_STR_TOKEN}` } : {}),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) {
          await prisma.sTR.update({
            where: { id: str.id },
            data: { status: "filed", filedAt: new Date() },
          });
          autoFiled = true;
        } else {
          console.error(`[aml] CBN STR webhook rejected with ${resp.status}: ${await resp.text()}`);
        }
      } catch (err) {
        console.error("[aml] CBN STR webhook submission failed:", err);
      }
    }

    // Notify super admin(s). If auto-filed, confirm; otherwise create a PENDING
    // report requiring MANUAL filing with the CBN within the 72-hour deadline.
    const members = await prisma.member.findMany({
      where: { cooperativeId: tx.cooperativeId, role: "superadmin", status: "active" },
    });
    for (const admin of members) {
      await notifyMember(
        admin,
        autoFiled
          ? `🚨 *STR Auto-Filed with CBN*\n\nMember: ${tx.memberId}\nAmount: ${formatBalance(tx.amount)}\nReason: ${reason}\nReference: ${str.id}`
          : `🚨 *STR Created (Pending CBN Filing)*\n\nMember: ${tx.memberId}\nAmount: ${formatBalance(tx.amount)}\nReason: ${reason}\n\nSet \`CBN_STR_WEBHOOK\` to auto-file. Until then, this report must be *manually filed with the CBN within 72 hours*.`,
      );
    }

    return { filed: true, strId: str.id };
  } catch (err) {
    console.error("[aml] autoFileSTR failed:", err);
    return { filed: false };
  }
}

/**
 * Check if a member's aggregate outflow within 24 hours meets or exceeds
 * the CBN ₦5,000,000 threshold. Returns the total amount if so.
 */
export async function checkAggregateThreshold(
  memberId: string,
  cooperativeId: string,
  threshold: number = LARGE_TX_THRESHOLD,
): Promise<{ exceeds: boolean; total: number }> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [withdrawals, payouts] = await Promise.all([
    prisma.withdrawalRequest.aggregate({
      where: {
        memberId,
        status: "paid",
        createdAt: { gte: since },
      },
      _sum: { amount: true },
    }),
    prisma.payout.aggregate({
      where: {
        memberId,
        cooperativeId,
        status: "successful",
        createdAt: { gte: since },
      },
      _sum: { amount: true },
    }),
  ]);

  const total = (withdrawals._sum.amount ?? 0) + (payouts._sum.amount ?? 0);
  return { exceeds: total >= threshold, total };
}
