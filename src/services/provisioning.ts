import { prisma, withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import { postJournal } from "./journal.js";
import { audit } from "./audit.js";
import { roundMoney } from "./money.js";

export type ParBucket = "1-30" | "31-90" | "91-180" | "180+";

export const PAR_BUCKETS: ParBucket[] = ["1-30", "31-90", "91-180", "180+"];

const DEFAULT_RATES: Record<ParBucket, number> = {
  "1-30": 1,
  "31-90": 5,
  "91-180": 20,
  "180+": 50,
};

export interface ParResult {
  buckets: Record<ParBucket, number>;
  total: number;
  parRatio: number;
}

export interface ProvisionEntryDraft {
  loanId: string;
  bucket: ParBucket;
  amount: number;
}

export interface ProvisionResult {
  entries: ProvisionEntryDraft[];
  total: number;
}

export interface RunProvisionResult {
  ok: boolean;
  message: string;
  runId?: string;
  total?: number;
}

const MS_PER_DAY = 86_400_000;

/** Days a loan's next installment is past due (negative when not yet due). */
function daysOverdue(dueDate: Date | null, now: Date): number {
  if (!dueDate) return 0;
  return Math.floor((now.getTime() - dueDate.getTime()) / MS_PER_DAY);
}

/** Outstanding loans that carry a balance and could be at risk. */
async function outstandingLoans(coopId: string) {
  return prisma.loan.findMany({
    where: {
      cooperativeId: coopId,
      status: { in: ["disbursed", "partial"] },
      balance: { gt: 0 },
    },
    select: { id: true, balance: true, dueDate: true },
  });
}

/** Older-than-1-day loans only; a loan due today or later is current. */
function bucketFor(days: number): ParBucket | null {
  if (days < 1) return null;
  if (days <= 30) return "1-30";
  if (days <= 90) return "31-90";
  if (days <= 180) return "91-180";
  return "180+";
}

/** The cooperative's arrears→percent map, falling back to the schema defaults. */
export async function provisionRates(coopId: string): Promise<Record<ParBucket, number>> {
  const config = await prisma.cooperativeConfig.findUnique({
    where: { cooperativeId: coopId },
    select: { provisionRates: true },
  });
  const parsed = config?.provisionRates ? safeParse(config.provisionRates) : null;
  const rates = { ...DEFAULT_RATES };
  if (parsed) {
    for (const bucket of PAR_BUCKETS) {
      const value = Number(parsed[bucket]);
      if (Number.isFinite(value)) rates[bucket] = value;
    }
  }
  return rates;
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Portfolio At Risk: outstanding balances bucketed by how overdue the next
 * installment is. `total` is the past-due balance; `parRatio` is that over the
 * whole outstanding portfolio (past due + current).
 */
export async function computePar(coopId: string, now = new Date()): Promise<ParResult> {
  const loans = await outstandingLoans(coopId);
  const buckets: Record<ParBucket, number> = { "1-30": 0, "31-90": 0, "91-180": 0, "180+": 0 };
  let portfolio = 0;
  for (const loan of loans) {
    portfolio += loan.balance;
    const bucket = bucketFor(daysOverdue(loan.dueDate, now));
    if (bucket) buckets[bucket] += loan.balance;
  }
  const total = PAR_BUCKETS.reduce((sum, b) => sum + buckets[b], 0);
  const parRatio = portfolio > 0 ? total / portfolio : 0;
  return { buckets, total, parRatio };
}

/**
 * Expected loan-loss provision per loan: outstanding balance × the bucket rate,
 * for every past-due loan. Current loans contribute nothing.
 */
export async function computeProvision(coopId: string, now = new Date()): Promise<ProvisionResult> {
  const [loans, rates] = await Promise.all([outstandingLoans(coopId), provisionRates(coopId)]);
  const entries: ProvisionEntryDraft[] = [];
  let total = 0;
  for (const loan of loans) {
    const bucket = bucketFor(daysOverdue(loan.dueDate, now));
    if (!bucket) continue;
    const amount = roundMoney((loan.balance * rates[bucket]) / 100);
    if (amount <= 0) continue;
    entries.push({ loanId: loan.id, bucket, amount });
    total = roundMoney(total + amount);
  }
  return { entries, total };
}

/**
 * Run the monthly provision for a cooperative: snapshot the per-loan expected
 * loss, book the movement to the loan-loss reserve, and bump the accumulated
 * reserve balance. One run per cooperative per period — re-running is refused
 * (the period's already been provided for).
 */
export async function runProvision(
  coopId: string,
  actor: { id: string; phone: string; role: string },
  now = new Date(),
): Promise<RunProvisionResult> {
  if (actor.role !== "admin" && actor.role !== "superadmin") {
    return { ok: false, message: "⛔ Only a cooperative admin can run provisioning." };
  }

  const period = now.toISOString().slice(0, 7);

  const existing = await prisma.provisionRun.findUnique({
    where: { cooperativeId_period: { cooperativeId: coopId, period } },
    select: { id: true },
  });
  if (existing) {
    return { ok: false, message: `Provisioning for *${period}* has already been run.` };
  }

  const { entries, total } = await computeProvision(coopId, now);

  let runId: string;
  try {
    runId = await withTx(async (tx) => {
      await setCoopContext(tx as never, coopId);
      const run = await prisma.provisionRun.create({
        data: {
          cooperativeId: coopId,
          period,
          totalProvision: total,
          createdById: actor.id,
          entries: { create: entries },
        },
      });
      if (total > 0) {
        await postJournal({
          cooperativeId: coopId,
          txRef: `PROVISION-${coopId}-${period}`,
          description: `Loan-loss provision ${period}`,
          postings: [
            { account: "expense:loan_loss_provision", direction: "DEBIT", amount: total },
            { account: "assets:loan_loss_provision", direction: "CREDIT", amount: total },
          ],
          throwOnDuplicate: true,
        });
        await prisma.cooperative.update({
          where: { id: coopId },
          data: { loanLossProvisionBalance: { increment: total } },
        });
      }
      return run.id;
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      return { ok: false, message: `Provisioning for *${period}* has already been run.` };
    }
    throw err;
  }

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "provision.run",
    targetType: "provisionRun",
    targetId: runId,
    amount: total,
    detail: `Loan-loss provision ${period}: ${entries.length} loans, ${total} kobo`,
  });

  return {
    ok: true,
    message:
      total > 0
        ? `✅ Provisioned *${entries.length}* past-due loan(s) for *${period}*: reserve increased by the run total.`
        : `✅ No past-due loans for *${period}* — provision is zero.`,
    runId,
    total,
  };
}
