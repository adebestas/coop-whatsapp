import { prisma } from "../lib/prisma.js";
import {
  listCooperativeIds,
  withCoopContext,
  rlsEnforcementStatus,
} from "../lib/tenant-context.js";
import { recentAudit } from "./audit.js";

/**
 * Loan states that represent money actually out with a member. Only these are
 * part of the outstanding book / delinquency picture.
 */
const ACTIVE_LOAN_STATUSES = ["disbursed"];

/** Per-cooperative monitoring snapshot. All money fields are kobo integers. */
export interface CoopStats {
  id: string;
  name: string;
  code: string;
  plan: string;
  status: string;
  memberCount: number;
  membersByStatus: Record<string, number>;
  loanCount: number;
  loanPrincipal: number;
  loanOutstanding: number;
  overdueCount: number;
  overdueAmount: number;
  delinquencyPct: number;
  savingsTotal: number;
  pendingPayouts: number;
  failedPayouts: number;
  pendingWithdrawals: number;
  walletFloat: number;
  pendingAmlCount: number;
  reserveFundBalance: number;
  loanLossProvisionBalance: number;
  lastActivityAt: Date | null;
}

export type CoopSummary = CoopStats;

export interface Alert {
  type: string;
  severity: "warning" | "critical";
  cooperativeId: string | null;
  cooperativeName: string | null;
  message: string;
}

export interface PlatformTotals {
  coopCount: number;
  memberCount: number;
  loanCount: number;
  loanPrincipal: number;
  loanOutstanding: number;
  overdueCount: number;
  overdueAmount: number;
  savingsTotal: number;
  walletFloat: number;
  pendingPayouts: number;
  failedPayouts: number;
  pendingWithdrawals: number;
  pendingAmlCount: number;
}

export interface PlatformOverview {
  totals: PlatformTotals;
  coops: CoopSummary[];
  alerts: Alert[];
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10000) / 100;
}

/**
 * Health stats for one cooperative. Every read runs inside the coop's RLS
 * context — never an unscoped query across coop-scoped tables — and every query
 * is additionally filtered by `cooperativeId` so SQLite (no RLS) stays isolated.
 */
export async function coopStats(coopId: string): Promise<CoopStats> {
  return withCoopContext(coopId, async () => {
    const [coop, membersByStatus, walletAgg, loans, subscription, lastAudit] = await Promise.all([
      prisma.cooperative.findUnique({ where: { id: coopId } }),
      prisma.member.groupBy({
        by: ["status"],
        where: { cooperativeId: coopId },
        _count: { _all: true },
      }),
      prisma.wallet.aggregate({
        where: { member: { cooperativeId: coopId } },
        _sum: { balance: true, totalSaved: true },
      }),
      prisma.loan.findMany({
        where: { cooperativeId: coopId, status: { in: ACTIVE_LOAN_STATUSES } },
        select: { amount: true, balance: true, dueDate: true },
      }),
      prisma.subscription.findUnique({ where: { cooperativeId: coopId } }),
      prisma.auditLog.findFirst({
        where: { cooperativeId: coopId },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);

    const [pendingPayouts, failedPayouts, pendingWithdrawals, pendingAmlCount] = await Promise.all([
      prisma.payout.count({ where: { cooperativeId: coopId, status: "pending" } }),
      prisma.payout.count({ where: { cooperativeId: coopId, status: "failed" } }),
      prisma.withdrawalRequest.count({ where: { cooperativeId: coopId, status: "pending" } }),
      prisma.sTR.count({ where: { cooperativeId: coopId, status: "pending" } }),
    ]);

    const byStatus: Record<string, number> = {};
    let memberCount = 0;
    for (const row of membersByStatus) {
      byStatus[row.status] = row._count._all;
      memberCount += row._count._all;
    }

    const now = Date.now();
    let loanPrincipal = 0;
    let loanOutstanding = 0;
    let overdueCount = 0;
    let overdueAmount = 0;
    for (const loan of loans) {
      loanPrincipal += loan.amount;
      loanOutstanding += loan.balance;
      if (loan.balance > 0 && loan.dueDate && loan.dueDate.getTime() < now) {
        overdueCount += 1;
        overdueAmount += loan.balance;
      }
    }

    return {
      id: coopId,
      name: coop?.name ?? "",
      code: coop?.code ?? "",
      plan: subscription?.plan ?? "free",
      status: coop?.status ?? "unknown",
      memberCount,
      membersByStatus: byStatus,
      loanCount: loans.length,
      loanPrincipal,
      loanOutstanding,
      overdueCount,
      overdueAmount,
      delinquencyPct: pct(overdueCount, loans.length),
      savingsTotal: walletAgg._sum.totalSaved ?? 0,
      pendingPayouts,
      failedPayouts,
      pendingWithdrawals,
      walletFloat: walletAgg._sum.balance ?? 0,
      pendingAmlCount,
      reserveFundBalance: coop?.reserveFundBalance ?? 0,
      loanLossProvisionBalance: coop?.loanLossProvisionBalance ?? 0,
      lastActivityAt: lastAudit?.createdAt ?? coop?.updatedAt ?? null,
    } satisfies CoopStats;
  });
}

/** Recent audit entries for a coop (its activity feed), inside its context. */
export async function coopActivity(coopId: string, take = 15) {
  return withCoopContext(coopId, () => recentAudit(coopId, take));
}

function alertsFor(stats: CoopSummary): Alert[] {
  const alerts: Alert[] = [];
  const who = { cooperativeId: stats.id, cooperativeName: stats.name };

  if (stats.delinquencyPct > 10) {
    alerts.push({
      type: "delinquency",
      severity: "warning",
      ...who,
      message: `${stats.name}: ${stats.delinquencyPct}% of the loan book is overdue`,
    });
  }
  if (stats.walletFloat < 0) {
    alerts.push({
      type: "negative_wallet",
      severity: "critical",
      ...who,
      message: `${stats.name}: negative wallet float (${stats.walletFloat} kobo)`,
    });
  }
  if (stats.failedPayouts > 0) {
    alerts.push({
      type: "failed_payouts",
      severity: "critical",
      ...who,
      message: `${stats.name}: ${stats.failedPayouts} payout(s) failed`,
    });
  }
  if (stats.pendingAmlCount > 0) {
    alerts.push({
      type: "aml_review",
      severity: "warning",
      ...who,
      message: `${stats.name}: ${stats.pendingAmlCount} suspicious transaction report(s) awaiting filing`,
    });
  }
  return alerts;
}

function rlsAlert(enforced: boolean): Alert | null {
  if (enforced) return null;
  return {
    type: "rls_not_enforced",
    severity: "critical",
    cooperativeId: null,
    cooperativeName: null,
    message:
      "Row-level security is not enforced for the database role — tenant isolation is not active",
  };
}

function sumTotals(coops: CoopSummary[]): PlatformTotals {
  const totals: PlatformTotals = {
    coopCount: coops.length,
    memberCount: 0,
    loanCount: 0,
    loanPrincipal: 0,
    loanOutstanding: 0,
    overdueCount: 0,
    overdueAmount: 0,
    savingsTotal: 0,
    walletFloat: 0,
    pendingPayouts: 0,
    failedPayouts: 0,
    pendingWithdrawals: 0,
    pendingAmlCount: 0,
  };
  for (const c of coops) {
    totals.memberCount += c.memberCount;
    totals.loanCount += c.loanCount;
    totals.loanPrincipal += c.loanPrincipal;
    totals.loanOutstanding += c.loanOutstanding;
    totals.overdueCount += c.overdueCount;
    totals.overdueAmount += c.overdueAmount;
    totals.savingsTotal += c.savingsTotal;
    totals.walletFloat += c.walletFloat;
    totals.pendingPayouts += c.pendingPayouts;
    totals.failedPayouts += c.failedPayouts;
    totals.pendingWithdrawals += c.pendingWithdrawals;
    totals.pendingAmlCount += c.pendingAmlCount;
  }
  return totals;
}

/**
 * Platform-wide snapshot: per-coop stats summed into totals, plus the alert set.
 * Coops are discovered through the SECURITY DEFINER `listCooperativeIds()` and
 * each one's rows are read inside its own context.
 */
export async function platformOverview(): Promise<PlatformOverview> {
  const ids = await listCooperativeIds();
  const coops: CoopSummary[] = [];
  for (const id of ids) {
    coops.push(await coopStats(id));
  }

  const rls = await rlsEnforcementStatus();
  const alerts: Alert[] = [];
  for (const c of coops) alerts.push(...alertsFor(c));
  const rlsIssue = rlsAlert(rls.enforced);
  if (rlsIssue) alerts.push(rlsIssue);

  return { totals: sumTotals(coops), coops, alerts };
}
