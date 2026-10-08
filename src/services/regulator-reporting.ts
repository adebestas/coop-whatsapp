import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { prisma, withTx } from "../lib/prisma.js";
import { setCoopContext, withCoopContext } from "../lib/tenant-context.js";
import { computePnl } from "./ledger.js";
import { computePar, computePearls } from "./provisioning.js";
import { audit } from "./audit.js";
import { formatBalance } from "../lib/money.js";
import { LARGE_TX_THRESHOLD } from "./aml.js";
import { EXPORT_DIR, buildReportFiles, emailFiles, type ReportSheet } from "./exports.js";
import { uploadToS3 } from "../lib/s3.js";

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
  links?: { xlsx: string; pdf: string };
}

/**
 * Optional I/O seams for `generateReport`, so tests can observe the file-build,
 * object-storage and email steps without needing live S3/SMTP. Production callers
 * omit them and get the real implementations.
 */
export interface GenerateReportDeps {
  buildFiles?: typeof buildReportFiles;
  upload?: (filePath: string, key: string) => Promise<boolean>;
  sendEmail?: typeof emailFiles;
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

  const [pnl, par, pearls, memberCount, savings, loanBook, savingsAccounts] = await Promise.all([
    computePnl(coopId, start, end),
    // Period-scope the statutory figures: PAR is measured as of the period end,
    // not generation time (and PEARLS' growth window likewise). Loan balances
    // remain current-state — there is no historical loan snapshot.
    computePar(coopId, end),
    computePearls(coopId, end),
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
    // Savings products hold member money outside `Contribution`; include their
    // balances so the savings and balance-sheet liabilities are complete.
    prisma.savingsAccount.aggregate({
      where: { cooperativeId: coopId },
      _sum: { balance: true },
    }),
  ]);

  const savingsTotal = savings._sum.amount ?? 0;
  const savingsCount = savings._count._all;
  const savingsAccountsTotal = savingsAccounts._sum.balance ?? 0;
  const totalLiabilities = savingsTotal + savingsAccountsTotal;
  const loanTotal = loanBook._sum.balance ?? 0;
  const loanCount = loanBook._count._all;

  // Net assets (loans are a contra-asset after the loan-loss reserve) reconcile
  // with liabilities + net capital. This is a PEARLS-derived summary, not a GAAP
  // balance sheet: share capital, wallet liabilities and other equity are not
  // represented, and loan balances are current-state (no historical snapshot).
  const netAssets = pearls.totals.assets - pearls.totals.allowance;
  const balanceSheet: ReportSheet = {
    name: "Balance Sheet",
    rows: [
      ["Item", "Amount"],
      ["Bank & cash", formatBalance(pearls.totals.bank)],
      ["Gross loan portfolio", formatBalance(pearls.totals.loans)],
      ["Less: loan-loss reserve", formatBalance(-pearls.totals.allowance)],
      ["Net loans", formatBalance(pearls.totals.loans - pearls.totals.allowance)],
      ["Total assets (net)", formatBalance(netAssets)],
      ["Member savings (liability)", formatBalance(savingsTotal)],
      ["Savings accounts (liability)", formatBalance(savingsAccountsTotal)],
      ["Total liabilities", formatBalance(totalLiabilities)],
      ["Net capital", formatBalance(netAssets - totalLiabilities)],
      ["Note", "PEARLS-derived summary — not a GAAP balance sheet; loan balances are current-state"],
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
      ["Confirmed savings (contributions)", formatBalance(savingsTotal)],
      ["Savings product balances", formatBalance(savingsAccountsTotal)],
      ["Total member savings", formatBalance(totalLiabilities)],
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

/**
 * Build the NFIU AML summaries pack for a cooperative and period, READ-ONLY:
 * STR/SAR counts grouped by status, and the large-transaction (≥ ₦5M) list —
 * all directions, matching the direction-agnostic AML large-transaction rule
 * (paid withdrawals + successful payouts + disbursed loans out; confirmed
 * contributions in).
 */
export async function nfiuPack(coopId: string, period: string): Promise<ReportSheet[]> {
  const { start, end } = periodRange(period);
  // Transactions are attributed to the period in which the money actually moved
  // (the completion timestamp), not when the request/record was created:
  // withdrawals by `finalizedAt`, contributions by `paidAt`. Payouts have no
  // dedicated completion column, so `updatedAt` (the last status transition) is
  // used. Records lacking a completion timestamp fall back to `createdAt` so
  // legacy rows are not dropped.
  const [strs, withdrawals, payouts, loans, deposits] = await Promise.all([
    prisma.sTR.findMany({
      where: { cooperativeId: coopId, createdAt: { gte: start, lte: end } },
      select: { status: true, amount: true },
    }),
    prisma.withdrawalRequest.findMany({
      where: {
        cooperativeId: coopId,
        status: "paid",
        amount: { gte: LARGE_TX_THRESHOLD },
        OR: [
          { finalizedAt: { gte: start, lte: end } },
          { finalizedAt: null, createdAt: { gte: start, lte: end } },
        ],
      },
      include: { member: { select: { name: true, code: true } } },
    }),
    prisma.payout.findMany({
      where: {
        cooperativeId: coopId,
        status: "successful",
        amount: { gte: LARGE_TX_THRESHOLD },
        updatedAt: { gte: start, lte: end },
      },
      include: { member: { select: { name: true, code: true } } },
    }),
    prisma.loan.findMany({
      where: {
        cooperativeId: coopId,
        amount: { gte: LARGE_TX_THRESHOLD },
        disbursedAt: { gte: start, lte: end },
      },
      include: { member: { select: { name: true, code: true } } },
    }),
    prisma.contribution.findMany({
      where: {
        cooperativeId: coopId,
        status: "confirmed",
        amount: { gte: LARGE_TX_THRESHOLD },
        OR: [
          { paidAt: { gte: start, lte: end } },
          { paidAt: null, createdAt: { gte: start, lte: end } },
        ],
      },
      include: { member: { select: { name: true, code: true } } },
    }),
  ]);

  // STR/SAR counts + total amount, grouped by filing status.
  const byStatus = new Map<string, { count: number; total: number }>();
  for (const str of strs) {
    const entry = byStatus.get(str.status) ?? { count: 0, total: 0 };
    entry.count += 1;
    entry.total += str.amount;
    byStatus.set(str.status, entry);
  }
  const strRows: string[][] = [["Status", "Count", "Total amount"]];
  for (const status of [...byStatus.keys()].sort()) {
    const entry = byStatus.get(status)!;
    strRows.push([status, String(entry.count), formatBalance(entry.total)]);
  }
  strRows.push([
    "Total",
    String(strs.length),
    formatBalance(strs.reduce((sum, s) => sum + s.amount, 0)),
  ]);
  const strSheet: ReportSheet = { name: "STR-SAR Summary", rows: strRows };

  // Large-transaction list (≥ ₦5M), all directions, oldest first.
  const large = [
    ...withdrawals.map((w) => ({
      date: w.finalizedAt ?? w.createdAt,
      direction: "out",
      type: "withdrawal",
      member: w.member.name,
      code: w.member.code,
      amount: w.amount,
    })),
    ...payouts.map((p) => ({
      date: p.updatedAt,
      direction: "out",
      type: "payout",
      member: p.member.name,
      code: p.member.code,
      amount: p.amount,
    })),
    ...loans.map((l) => ({
      date: l.disbursedAt ?? l.createdAt,
      direction: "out",
      type: "loan disbursement",
      member: l.member.name,
      code: l.member.code,
      amount: l.amount,
    })),
    ...deposits.map((c) => ({
      date: c.paidAt ?? c.createdAt,
      direction: "in",
      type: "contribution",
      member: c.member.name,
      code: c.member.code,
      amount: c.amount,
    })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());
  const largeSheet: ReportSheet = {
    name: "Large Transactions",
    rows: [
      ["Date", "Direction", "Type", "Member", "Code", "Amount"],
      ...large.map((tx) => [
        tx.date.toISOString().slice(0, 10),
        tx.direction,
        tx.type,
        tx.member,
        tx.code,
        formatBalance(tx.amount),
      ]),
    ],
  };

  return [strSheet, largeSheet];
}

/** The due-day profile (and contact email) for a coop, with schema defaults. */
async function dueProfile(
  coopId: string,
): Promise<RegulatorDueProfile & { contactEmail: string | null }> {
  const profile = await prisma.regulatorProfile.findFirst({
    where: { cooperativeId: coopId, active: true },
    orderBy: { createdAt: "desc" },
    select: { monthlyDueDay: true, quarterlyDueDay: true, contactEmail: true },
  });
  return {
    monthlyDueDay: profile?.monthlyDueDay ?? DEFAULT_DUE.monthlyDueDay,
    quarterlyDueDay: profile?.quarterlyDueDay ?? DEFAULT_DUE.quarterlyDueDay,
    contactEmail: profile?.contactEmail ?? null,
  };
}

/**
 * Generate a regulator report pack for a coop and period. DB reads run in a
 * short read transaction; the file build + object-storage upload + email then
 * run OUTSIDE any transaction (heavy ExcelJS/PDFKit work must never hold a
 * connection open), and only the upsert is committed. Idempotent per
 * period/type/pack; a regeneration preserves an already-filed pack. `statutory`
 * returns the financial-returns sheets; `nfiu` the AML summaries; `both` both.
 */
export async function generateReport(
  coopId: string,
  period: string,
  periodType: PeriodType,
  packType: PackType,
  actorId?: string,
  deps: GenerateReportDeps = {},
): Promise<GenerateReportResult> {
  if (packType !== "statutory" && packType !== "nfiu" && packType !== "both") {
    return {
      ok: false,
      message: `Unknown pack type *${packType}*. Use *statutory*, *nfiu* or *both*.`,
    };
  }

  const buildFiles = deps.buildFiles ?? buildReportFiles;
  const upload = deps.upload ?? uploadToS3;
  const sendEmail = deps.sendEmail ?? emailFiles;

  // Phase 1 — read-only data gathering, scoped to the coop's RLS context. The
  // transaction closes before any file I/O begins.
  const { coop, profile, sheets } = await withCoopContext(coopId, async () => {
    const [coop, profile] = await Promise.all([
      prisma.cooperative.findUnique({ where: { id: coopId }, select: { name: true } }),
      dueProfile(coopId),
    ]);
    const sheets: ReportSheet[] = [];
    if (packType === "statutory" || packType === "both") {
      sheets.push(...(await statutoryPack(coopId, period)));
    }
    if (packType === "nfiu" || packType === "both") {
      sheets.push(...(await nfiuPack(coopId, period)));
    }
    return { coop, profile, sheets };
  });

  const dueAt = periodDueAt(period, periodType, profile);

  // Phase 2 — build the artifacts and deliver them. All of this (ExcelJS +
  // PDFKit, S3 upload, SMTP) happens with no transaction open.
  await mkdir(EXPORT_DIR, { recursive: true });
  const token = randomBytes(8).toString("hex");
  // `<coopId>-regulator-<hex>` is coop-scoped and passes the `/api/export`
  // route's filename allow-list (it leads with the cooperative id).
  const base = join(EXPORT_DIR, `${coopId}-regulator-${token}`);
  const files = await buildFiles(
    base,
    `${coop?.name ?? "Cooperative"} — Regulator ${packType} report ${period}`,
    sheets,
  );

  const s3Keys: string[] = [];
  for (const filePath of [files.xlsx, files.pdf, files.csv]) {
    const key = `exports/${coopId}/${basename(filePath)}`;
    if (await upload(filePath, key)) s3Keys.push(key);
  }
  const storage =
    s3Keys.length === 3 ? "S3" : s3Keys.length > 0 ? "S3 (partial)" : "local";

  const baseUrl =
    process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? "3000"}`;
  const links = {
    xlsx: `${baseUrl}/api/export/${basename(files.xlsx)}`,
    pdf: `${baseUrl}/api/export/${basename(files.pdf)}`,
  };

  let emailNote = "";
  if (profile.contactEmail && process.env.SMTP_HOST) {
    const sent = await sendEmail(
      profile.contactEmail,
      `[${coop?.name ?? "Coop"}] ${packType} regulator report ${period}`,
      `Attached is the ${packType} regulator pack for ${period}.\n\n${links.xlsx}\n${links.pdf}`,
      [files.xlsx, files.pdf],
    );
    emailNote = sent
      ? `\n\n📧 Emailed to ${profile.contactEmail}.`
      : `\n\n⚠️ Email delivery failed — use the download links.`;
  }

  // Phase 3 — persist. Never reset `status`/`filedAt`: regenerating a pack that
  // a coop has already filed must not silently un-file it.
  const report = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    const saved = await tx.regulatorReport.upsert({
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
        generatedAt: new Date(),
        generatedById: actorId ?? null,
        files: JSON.stringify(files),
        dueAt,
      },
    });
    await audit({
      cooperativeId: coopId,
      actorPhone: "regulator",
      actorId: actorId ?? null,
      actorRole: "system",
      action: "regulator.report_generate",
      targetType: "regulatorReport",
      targetId: saved.id,
      detail: `${packType} ${periodType} regulator pack for ${period} generated`,
    });
    return saved;
  });

  return {
    ok: true,
    message:
      `✅ *${packType}* regulator pack for *${period}* is ready (stored on ${storage}).\n\n` +
      `📊 Excel: ${links.xlsx}\n📄 PDF: ${links.pdf}\n` +
      `🗓️ Filing due: ${dueAt.toISOString().slice(0, 10)}${emailNote}`,
    reportId: report.id,
    files,
    links,
  };
}

/** Valid `RegulatorProfile.type` values (no Prisma enum — plain strings). */
const REGULATOR_TYPES = new Set(["ministry", "cbn", "nfiu", "custom"]);

/** A compact view of a `RegulatorReport` for the admin console. */
export interface ReportSummary {
  id: string;
  period: string;
  periodType: string;
  packType: string;
  status: string;
  dueAt: Date | null;
  filedAt: Date | null;
  files: { xlsx: string; pdf: string; csv: string } | null;
}

/**
 * Configure (create or update) a coop's active `RegulatorProfile`: the regulator
 * label/type, optional contact email, and the monthly/quarterly filing due days.
 * Also flips `CooperativeConfig.regulatorReportingEnabled` on so the scheduler
 * begins generating packs. Coop-scoped write via `withTx` + `setCoopContext`,
 * audited as `regulator.profile_set`.
 */
export async function setRegulatorProfile(
  coopId: string,
  input: {
    label?: string;
    type?: string;
    contactEmail?: string;
    monthlyDueDay?: number;
    quarterlyDueDay?: number;
  },
  actor: { id: string; phone: string },
): Promise<{ ok: boolean; message: string }> {
  const type = input.type?.trim().toLowerCase();
  if (type && !REGULATOR_TYPES.has(type)) {
    return {
      ok: false,
      message: `Unknown regulator type *${input.type}*. Use *ministry*, *cbn*, *nfiu* or *custom*.`,
    };
  }
  for (const [label, day] of [
    ["Monthly", input.monthlyDueDay],
    ["Quarterly", input.quarterlyDueDay],
  ] as const) {
    if (day !== undefined && (!Number.isInteger(day) || day < 1 || day > 28)) {
      return { ok: false, message: `${label} due day must be between 1 and 28.` };
    }
  }

  const label = input.label?.trim();
  const existing = await prisma.regulatorProfile.findFirst({
    where: { cooperativeId: coopId, active: true },
    orderBy: { createdAt: "desc" },
  });
  if (!existing && !label) {
    return {
      ok: false,
      message:
        "Provide a regulator label, e.g. *regulatorconfig Lagos State Ministry ministry 10 15*.",
    };
  }

  const profile = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    if (existing) {
      return tx.regulatorProfile.update({
        where: { id: existing.id },
        data: {
          ...(label ? { label } : {}),
          ...(type ? { type } : {}),
          ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail || null } : {}),
          ...(input.monthlyDueDay !== undefined ? { monthlyDueDay: input.monthlyDueDay } : {}),
          ...(input.quarterlyDueDay !== undefined ? { quarterlyDueDay: input.quarterlyDueDay } : {}),
        },
      });
    }
    return tx.regulatorProfile.create({
      data: {
        cooperativeId: coopId,
        label: label!,
        type: type ?? "custom",
        contactEmail: input.contactEmail || null,
        monthlyDueDay: input.monthlyDueDay ?? DEFAULT_DUE.monthlyDueDay,
        quarterlyDueDay: input.quarterlyDueDay ?? DEFAULT_DUE.quarterlyDueDay,
      },
    });
  });

  // A configured regulator means the coop now files returns — switch scheduled
  // generation on so the scheduler produces the packs.
  await prisma.cooperativeConfig.upsert({
    where: { cooperativeId: coopId },
    create: { cooperativeId: coopId, regulatorReportingEnabled: true },
    update: { regulatorReportingEnabled: true },
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: "admin",
    action: "regulator.profile_set",
    targetType: "regulatorProfile",
    targetId: profile.id,
    detail: `Regulator set to ${profile.label} (${profile.type}); monthly due ${profile.monthlyDueDay}, quarterly due ${profile.quarterlyDueDay}`,
  });

  return {
    ok: true,
    message:
      `✅ Regulator set to *${profile.label}* (${profile.type}).\n` +
      `🗓️ Monthly returns due day *${profile.monthlyDueDay}*, quarterly due day *${profile.quarterlyDueDay}*. ` +
      `Scheduled packs are now enabled.`,
  };
}

/**
 * Mark a generated regulator pack as filed. `reportId` may be a full id or a
 * unique suffix (matching the shorter ids shown in chat). Coop-scoped write via
 * `withTx` + `setCoopContext`, audited as `regulator.report_filed`.
 */
export async function markFiled(
  coopId: string,
  reportId: string,
  actor: { id: string; phone: string },
): Promise<{ ok: boolean; message: string }> {
  const ref = reportId?.trim();
  if (!ref) return { ok: false, message: "Usage: *regreport filed <report id>*." };

  const report = await prisma.regulatorReport.findFirst({
    where: { cooperativeId: coopId, id: { endsWith: ref } },
    orderBy: { generatedAt: "desc" },
  });
  if (!report) {
    return { ok: false, message: `No regulator report matching *${ref}* in your cooperative.` };
  }
  if (report.status === "filed") {
    return {
      ok: true,
      message: `ℹ️ The *${report.period}* ${report.periodType} pack is already marked filed.`,
    };
  }

  const filedAt = new Date();
  await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    await tx.regulatorReport.update({
      where: { id: report.id },
      data: { status: "filed", filedAt },
    });
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: "admin",
    action: "regulator.report_filed",
    targetType: "regulatorReport",
    targetId: report.id,
    detail: `${report.periodType} ${report.packType} pack for ${report.period} marked filed`,
  });

  return {
    ok: true,
    message: `✅ *${report.period}* ${report.periodType} regulator pack marked *filed*.`,
  };
}

/** List a coop's generated/filed regulator packs, newest due first. */
export async function listReports(
  coopId: string,
): Promise<{ ok: boolean; message: string; reports?: ReportSummary[] }> {
  const rows = await prisma.regulatorReport.findMany({
    where: { cooperativeId: coopId },
    orderBy: [{ dueAt: "desc" }, { generatedAt: "desc" }],
    take: 50,
  });

  const reports: ReportSummary[] = rows.map((r) => {
    let files: ReportSummary["files"] = null;
    if (r.files) {
      try {
        files = JSON.parse(r.files) as ReportSummary["files"];
      } catch {
        files = null;
      }
    }
    return {
      id: r.id,
      period: r.period,
      periodType: r.periodType,
      packType: r.packType,
      status: r.status,
      dueAt: r.dueAt,
      filedAt: r.filedAt,
      files,
    };
  });

  if (reports.length === 0) {
    return {
      ok: true,
      message:
        "No regulator packs generated yet. Use *regreport <period> <statutory|nfiu|both>* to create one.",
      reports,
    };
  }

  return { ok: true, message: `*📋 Regulator packs (${reports.length})*`, reports };
}
