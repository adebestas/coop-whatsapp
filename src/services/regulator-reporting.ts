import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { prisma, withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import { computePnl } from "./ledger.js";
import { computePar, computePearls } from "./provisioning.js";
import { audit } from "./audit.js";
import { formatBalance } from "../lib/money.js";
import { EXPORT_DIR, buildReportFiles, type ReportSheet } from "./exports.js";

export type PeriodType = "monthly" | "quarterly";
export type PackType = "statutory" | "nfiu" | "both";

export interface RegulatorDueProfile {
  monthlyDueDay: number;
  quarterlyDueDay: number;
}

export interface GenerateReportResult {
  ok: boolean;
  message: string;
  reportId?: string;
  files?: { xlsx: string; pdf: string; csv: string };
}

const DEFAULT_DUE: RegulatorDueProfile = { monthlyDueDay: 10, quarterlyDueDay: 15 };

/** `YYYY-MM` for the period a report generated at `now` covers. */
export function reportPeriod(now: Date, periodType: PeriodType): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-11
  if (periodType === "monthly") {
    return `${year}-${String(month + 1).padStart(2, "0")}`;
  }
  // Quarterly returns are named for the quarter-end month (Jan-Mar → 03).
  const quarterEndMonth = Math.ceil((month + 1) / 3) * 3;
  return `${year}-${String(quarterEndMonth).padStart(2, "0")}`;
}

/**
 * The filing due date for a period: the due day of the month *after* the
 * period (monthly) or the quarter-end (quarterly). Built in UTC so the
 * calendar date survives any server timezone.
 */
export function periodDueAt(
  period: string,
  periodType: PeriodType,
  profile: RegulatorDueProfile,
): Date {
  const [year, month] = period.split("-").map(Number);
  const dueDay = periodType === "monthly" ? profile.monthlyDueDay : profile.quarterlyDueDay;
  // `month` is 1-based (03 = March); Date.UTC's 0-based month rolls forward.
  return new Date(Date.UTC(year, month, dueDay));
}

/** UTC [start, end] bounds of a `YYYY-MM` period (first ms → last ms). */
function periodRange(period: string): { start: Date; end: Date } {
  const [year, month] = period.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
  };
}

/** A ratio (fraction) rendered as a percentage string. */
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

/**
 * Build the statutory financial-returns pack for a cooperative and period,
 * READ-ONLY from existing data: P&L (ledger), balance sheet (PEARLS-derived),
 * PAR aging + PEARLS ratios (provisioning), and membership/savings/loans
 * summaries. Money is integer kobo, formatted with `formatBalance`.
 */
export async function statutoryPack(coopId: string, period: string): Promise<ReportSheet[]> {
  const { start, end } = periodRange(period);

  const [pnl, par, pearls, memberCount, savings, loanBook] = await Promise.all([
    computePnl(coopId, start, end),
    computePar(coopId),
    computePearls(coopId),
    prisma.member.count({ where: { cooperativeId: coopId } }),
    prisma.contribution.aggregate({
      where: { cooperativeId: coopId, status: "confirmed" },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.loan.aggregate({
      where: { cooperativeId: coopId, balance: { gt: 0 } },
      _sum: { balance: true },
      _count: { _all: true },
    }),
  ]);

  const savingsTotal = savings._sum.amount ?? 0;
  const savingsCount = savings._count._all;
  const loanTotal = loanBook._sum.balance ?? 0;
  const loanCount = loanBook._count._all;

  const balanceSheet: ReportSheet = {
    name: "Balance Sheet",
    rows: [
      ["Item", "Amount"],
      ["Total assets", formatBalance(pearls.totals.assets)],
      ["  Bank & cash", formatBalance(pearls.totals.bank)],
      ["  Loan portfolio", formatBalance(pearls.totals.loans)],
      ["Member savings (liability)", formatBalance(pearls.totals.savings)],
      ["Loan-loss reserve", formatBalance(pearls.totals.allowance)],
      ["Net capital", formatBalance(pearls.totals.assets - pearls.totals.savings)],
    ],
  };

  const pnlRows: string[][] = [["Category", "Type", "Amount"]];
  for (const [category, amount] of Object.entries(pnl.incomeByCategory)) {
    pnlRows.push([category, "income", formatBalance(amount)]);
  }
  for (const [category, amount] of Object.entries(pnl.expenseByCategory)) {
    pnlRows.push([category, "expense", formatBalance(amount)]);
  }
  pnlRows.push(["Total income", "", formatBalance(pnl.totalIncome)]);
  pnlRows.push(["Total expense", "", formatBalance(pnl.totalExpense)]);
  pnlRows.push(["Net profit", "", formatBalance(pnl.netProfit)]);
  const profits: ReportSheet = { name: "Profit & Loss", rows: pnlRows };

  const parAging: ReportSheet = {
    name: "PAR Aging",
    rows: [
      ["Bucket (days)", "Amount"],
      ["1-30", formatBalance(par.buckets["1-30"])],
      ["31-90", formatBalance(par.buckets["31-90"])],
      ["91-180", formatBalance(par.buckets["91-180"])],
      ["180+", formatBalance(par.buckets["180+"])],
      ["Total past due", formatBalance(par.total)],
      ["Outstanding portfolio", formatBalance(par.portfolio)],
      ["PAR ratio", pct(par.parRatio)],
    ],
  };

  const pearlsSheet: ReportSheet = {
    name: "PEARLS",
    rows: [
      ["Group", "Metric", "Value"],
      ["Protection", "Allowance to loans", pct(pearls.protection.allowanceToLoans)],
      ["Protection", "Net capital ratio", pct(pearls.protection.netCapital)],
      ["Effective structure", "Loans to assets", pct(pearls.effectiveStructure.loansToAssets)],
      ["Effective structure", "Savings to assets", pct(pearls.effectiveStructure.savingsToAssets)],
      ["Asset quality", "PAR ratio", pct(pearls.assetQuality.parRatio)],
      ["Asset quality", "Provision coverage", pct(pearls.assetQuality.provisionCoverage)],
      ["Rates of return", "Interest income to assets", pct(pearls.ratesOfReturn.interestIncomeToAssets)],
      ["Rates of return", "Cost of funds", pct(pearls.ratesOfReturn.costOfFunds)],
      ["Liquidity", "Liquid assets to savings", pct(pearls.liquidity.liquidAssetsToSavings)],
      ["Signs of growth", "Member growth", pct(pearls.signsOfGrowth.memberGrowth)],
      ["Signs of growth", "Savings growth", pct(pearls.signsOfGrowth.savingsGrowth)],
    ],
  };

  const membership: ReportSheet = {
    name: "Membership",
    rows: [
      ["Metric", "Value"],
      ["Total members", String(memberCount)],
    ],
  };

  const savingsSheet: ReportSheet = {
    name: "Savings",
    rows: [
      ["Metric", "Value"],
      ["Confirmed savings", formatBalance(savingsTotal)],
      ["Confirmed contributions", String(savingsCount)],
    ],
  };

  const loansSheet: ReportSheet = {
    name: "Loans",
    rows: [
      ["Metric", "Value"],
      ["Outstanding loan portfolio", formatBalance(loanTotal)],
      ["Outstanding loans", String(loanCount)],
      ["Past due", formatBalance(par.total)],
    ],
  };

  return [balanceSheet, profits, parAging, pearlsSheet, membership, savingsSheet, loansSheet];
}

/** The due-day profile for a coop, falling back to the schema defaults. */
async function dueProfile(coopId: string): Promise<RegulatorDueProfile> {
  const profile = await prisma.regulatorProfile.findFirst({
    where: { cooperativeId: coopId, active: true },
    orderBy: { createdAt: "desc" },
    select: { monthlyDueDay: true, quarterlyDueDay: true },
  });
  return {
    monthlyDueDay: profile?.monthlyDueDay ?? DEFAULT_DUE.monthlyDueDay,
    quarterlyDueDay: profile?.quarterlyDueDay ?? DEFAULT_DUE.quarterlyDueDay,
  };
}

/**
 * Generate a regulator report pack for a coop and period: write xlsx + pdf +
 * csv, then upsert the `RegulatorReport` (idempotent per period/type/pack) and
 * audit the generation. Only the statutory pack exists today; the NFIU pack is
 * a later task.
 */
export async function generateReport(
  coopId: string,
  period: string,
  periodType: PeriodType,
  packType: PackType,
  actorId?: string,
): Promise<GenerateReportResult> {
  if (packType !== "statutory") {
    return {
      ok: false,
      message: `The *${packType}* pack is not yet implemented. Generate the *statutory* pack for now.`,
    };
  }

  const [coop, profile] = await Promise.all([
    prisma.cooperative.findUnique({ where: { id: coopId }, select: { name: true } }),
    dueProfile(coopId),
  ]);

  const sheets = await statutoryPack(coopId, period);
  const dueAt = periodDueAt(period, periodType, profile);

  await mkdir(EXPORT_DIR, { recursive: true });
  const token = randomBytes(8).toString("hex");
  const base = join(EXPORT_DIR, `regulator-${coopId}-${period}-${periodType}-${packType}-${token}`);
  const files = await buildReportFiles(
    base,
    `${coop?.name ?? "Cooperative"} — Regulator ${packType} report ${period}`,
    sheets,
  );

  const report = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    return tx.regulatorReport.upsert({
      where: {
        cooperativeId_period_periodType_packType: {
          cooperativeId: coopId,
          period,
          periodType,
          packType,
        },
      },
      create: {
        cooperativeId: coopId,
        period,
        periodType,
        packType,
        status: "generated",
        generatedById: actorId ?? null,
        files: JSON.stringify(files),
        dueAt,
      },
      update: {
        status: "generated",
        generatedAt: new Date(),
        generatedById: actorId ?? null,
        files: JSON.stringify(files),
        dueAt,
        filedAt: null,
      },
    });
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: "regulator",
    actorId: actorId ?? null,
    actorRole: "system",
    action: "regulator.report_generate",
    targetType: "regulatorReport",
    targetId: report.id,
    detail: `${packType} ${periodType} regulator pack for ${period} generated`,
  });

  return {
    ok: true,
    message:
      `✅ *${packType}* regulator pack for *${period}* is ready.\n\n` +
      `📊 Excel: ${files.xlsx}\n📄 PDF: ${files.pdf}\n🧾 CSV: ${files.csv}\n` +
      `🗓️ Filing due: ${dueAt.toISOString().slice(0, 10)}`,
    reportId: report.id,
    files,
  };
}
