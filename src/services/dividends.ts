import { prisma, withTx, withTxBatch } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { computePnl } from "./ledger.js";
import { postJournal, getBankAccountBalance } from "./journal.js";
import { setCoopContext, resolveCoopByPayoutReference, withCoopContext } from "../lib/tenant-context.js";
import { sendToBank } from "./disbursements.js";
import { roundMoney } from "./money.js";
import { updateCoopConfig } from "./coop-config.js";
import { notifyMember } from "../lib/messaging.js";
import { notifySuperAdmins } from "./withdrawals.js";
import { alertSupers, AlertSeverity } from "../lib/alerting.js";
import { audit } from "./audit.js";

// ---------------------------------------------------------------------------
// Dividend engine — DIRECT-TO-BANK payouts.
//
// Accounting model (strict double-entry, all amounts in kobo):
//   1. Statutory appropriation  DEBIT  appropriation:statutory_funds
//                               CREDIT liabilities:reserve_fund
//   2. Declaration to members   DEBIT  appropriation:dividend
//                               CREDIT liabilities:dividend_payable
//   3. Bank payout of a share   DEBIT  liabilities:dividend_payable
//                               CREDIT assets:bank
//   4. Reversal (confirmed fail)DEBIT  assets:bank
//                               CREDIT liabilities:dividend_payable
//
// NOTE on the original spec wording ("Debit the corporate payout asset pool /
// Credit the member's yield account"): that phrasing is not a balanced pair and
// would re-introduce Finding F. The correct pairs above settle the member
// dividend PAYABLE against the BANK ASSET — the two legs that actually move.
//
// Payout is a SAGA, never an in-transaction HTTP call:
//   DB claim + journals commit first, then the provider is called, then the
//   entry is settled or the journal is reversed. External calls inside a
//   transaction would hold locks and could send money while the tx rolls back.
// ---------------------------------------------------------------------------

// Nigerian cooperative statutory deductions, applied to NET PROFIT.
const RESERVE_FUND_RATE = 0.2; // 20%
const EDUCATION_FUND_RATE = 0.02; // 2%
const DEVELOPMENT_FUND_RATE = 0.05; // 5%
const MAX_DIVIDEND_RATE = 25; // per Nigerian Cooperative Societies Act

/** Maximum number of bank payouts a single run may initiate (drain guard). */
export const DIVIDEND_MAX_PAYOUTS_PER_RUN = Math.max(
  1,
  Number(process.env.DIVIDEND_MAX_PAYOUTS ?? 500) || 500,
);
/** Parallel bank transfers per run — bounded so we never hammer the gateway. */
export const DIVIDEND_PAYOUT_CONCURRENCY = Math.max(
  1,
  Number(process.env.DIVIDEND_PAYOUT_CONCURRENCY ?? 5) || 5,
);

/** Deterministic idempotency key for a member's dividend payout (Payout + journal). */
export function dividendPayoutRef(dividendId: string, memberId: string): string {
  return `DIV-PAY-${dividendId}-${memberId}`;
}

export interface DividendRunResult {
  ok: boolean;
  message: string;
  dividendId?: string;
  /** Entries whose bank transfer was confirmed. */
  settled?: number;
  /** Entries held because the member has no verified bank account. */
  held?: number;
  /** Entries whose transfer failed (journal reversed). */
  failed?: number;
  totalPool?: number;
}

export type DividendBasis = "savings" | "shares";

function weightOf(
  m: { wallet: { totalSaved: number } | null; shareAccount?: { shares: number } | null },
  basis: DividendBasis,
): number {
  return basis === "shares" ? (m.shareAccount?.shares ?? 0) : (m.wallet?.totalSaved ?? 0);
}

/** Runtime guard: anything other than the exact "shares" tag behaves as savings. */
function normalizeBasis(basis: DividendBasis): DividendBasis {
  return basis === "shares" ? "shares" : "savings";
}

/** Start of the current fiscal dividend period (calendar year, local time). */
function currentPeriodStart(now = new Date()): Date {
  return new Date(now.getFullYear(), 0, 1);
}

interface DividendBase {
  netProfit: number;
  /** Statutory 20/2/5% already appropriated this period, in kobo. */
  statutoryTakenThisPeriod: number;
  /** Dividend pools already declared this period, in kobo. */
  priorPoolsThisPeriod: number;
  /** Profit still available to distribute this period, in kobo. */
  remaining: number;
}

/**
 * Profit available for distribution this period, after statutory funds already
 * appropriated and dividends already declared. Statutory 20/2/5% is taken at
 * most once per period (see the callers), so a second dividend run in the same
 * period shares the same profit base and takes no statutory again.
 */
async function computeDividendBase(cooperativeId: string): Promise<DividendBase> {
  const periodStart = currentPeriodStart();
  const pnl = await computePnl(cooperativeId);
  const [reserve, education, development, priorDividends] = await Promise.all([
    prisma.reserveAllocation.aggregate({
      where: { cooperativeId, source: "dividend_declaration", createdAt: { gte: periodStart } },
      _sum: { amount: true },
    }),
    prisma.educationFund.aggregate({
      where: { cooperativeId, source: "dividend_declaration", createdAt: { gte: periodStart } },
      _sum: { amount: true },
    }),
    prisma.developmentFund.aggregate({
      where: { cooperativeId, source: "dividend_declaration", createdAt: { gte: periodStart } },
      _sum: { amount: true },
    }),
    prisma.dividend.aggregate({
      where: { cooperativeId, createdAt: { gte: periodStart } },
      _sum: { totalPool: true },
    }),
  ]);
  const statutoryTakenThisPeriod =
    (reserve._sum.amount ?? 0) + (education._sum.amount ?? 0) + (development._sum.amount ?? 0);
  const priorPoolsThisPeriod = priorDividends._sum.totalPool ?? 0;
  const remaining = Math.max(0, pnl.netProfit - statutoryTakenThisPeriod - priorPoolsThisPeriod);
  return {
    netProfit: pnl.netProfit,
    statutoryTakenThisPeriod,
    priorPoolsThisPeriod,
    remaining,
  };
}

/** Largest-remainder (Hamilton) allocation of `pool` kobo across weighted members. */
function allocateShares(
  members: {
    id: string;
    wallet: { totalSaved: number } | null;
    shareAccount?: { shares: number } | null;
  }[],
  pool: number,
  basis: DividendBasis = "savings",
): Map<string, number> {
  const eligible = members.filter((m) => weightOf(m, basis) > 0);
  const totalWeight = eligible.reduce((sum, m) => sum + weightOf(m, basis), 0);
  const shares = new Map<string, number>();
  if (totalWeight <= 0 || pool <= 0) return shares;

  const raw = eligible.map((m) => {
    const exact = (weightOf(m, basis) / totalWeight) * pool;
    const kobo = Math.floor(exact);
    return { id: m.id, kobo, remainder: exact - kobo };
  });
  let leftover = pool - raw.reduce((sum, r) => sum + r.kobo, 0);
  raw.sort((a, b) => b.remainder - a.remainder);
  for (const r of raw) {
    if (leftover <= 0) break;
    r.kobo += 1;
    leftover -= 1;
  }
  for (const r of raw) shares.set(r.id, r.kobo);
  return shares;
}

/** Bounded-concurrency runner (no external dependency). */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Statutory / preview helpers
// ---------------------------------------------------------------------------

/** Compute an instant dividend preview for any caller (real-time). */
export async function computeDividendPreview(
  phone: string,
  rate: number,
): Promise<{ ok: boolean; message: string }> {
  if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
    return {
      ok: false,
      message: "Rate must be between 0 and 100, e.g. *dividend 50* for 50% of profit.",
    };
  }

  const member = await prisma.member.findFirst({
    where: { phone },
    include: { cooperative: true },
  });
  if (!member) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };
  }

  const pnl = await computePnl(member.cooperativeId);
  const entries = await prisma.member.findMany({
    where: { cooperativeId: member.cooperativeId },
    select: { id: true, name: true, wallet: { select: { totalSaved: true, balance: true } } },
  });
  const reserveAmount = Math.floor(pnl.netProfit * RESERVE_FUND_RATE);
  const educationAmount = Math.floor(pnl.netProfit * EDUCATION_FUND_RATE);
  const developmentAmount = Math.floor(pnl.netProfit * DEVELOPMENT_FUND_RATE);
  const totalDeductions = reserveAmount + educationAmount + developmentAmount;
  const distributableProfit = Math.max(0, pnl.netProfit - totalDeductions);
  const pool = Math.max(0, Math.round(distributableProfit * (rate / 100)));

  const shares = allocateShares(entries, pool);
  const myShare = shares.get(member.id) ?? 0;

  const lines = [
    `*🎉 Dividend calculator (real-time)*`,
    ``,
    `Coop net profit: ${formatBalance(pnl.netProfit)} (income ${formatBalance(pnl.totalIncome)} − expenses ${formatBalance(pnl.totalExpense)})`,
    `Rate: *${rate}% of profit*`,
    `Dividend pool: *${formatBalance(pool)}*`,
    ``,
    `*Statutory Deductions (Nigerian Cooperative Standard):*`,
    `• Reserve Fund (20%): *${formatBalance(reserveAmount)}*`,
    `• Education Fund (2%): *${formatBalance(educationAmount)}*`,
    `• Development Fund (5%): *${formatBalance(developmentAmount)}*`,
    `• Total deductions: *${formatBalance(totalDeductions)}*`,
    ``,
    `Member pool: *${formatBalance(pool)}*`,
    ``,
    `Your share: *${formatBalance(myShare)}* (based on your savings share)`,
  ];

  if (entries.length <= 5 && pool > 0) {
    lines.push(``, `*Shares:*`);
    for (const m of entries) {
      lines.push(`• ${m.name} — ${formatBalance(shares.get(m.id) ?? 0)}`);
    }
  }

  lines.push(
    ``,
    `Super admin: reply *paydividend ${rate}* to pay everyone directly to their bank.`,
  );
  return { ok: true, message: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Direct-to-bank distribution (saga)
// ---------------------------------------------------------------------------

/**
 * Super admin distributes a dividend run — % of actual net profit, paid
 * DIRECTLY to each member's bank account.
 *
 * Safety:
 *  - Kobo integers only (no float drift).
 *  - Journal-derived bank-float check BEFORE any transfer.
 *  - Bulk guards: max payouts/run + bounded concurrency.
 *  - Members without a verified bank account are HELD as a payable, not paid.
 *  - Idempotent per (dividend, member) via deterministic Payout keys.
 */
export interface DividendRunPreview {
  ok: boolean;
  message: string;
  /** The exact token the super admin must send to execute the run. */
  confirmToken?: string;
  pool?: number;
  payoutCount?: number;
  heldCount?: number;
  bankFloat?: number;
}

/**
 * Dry-run a dividend distribution and return the numbers a super admin must
 * see BEFORE any money moves. This is the first half of the two-step guardrail:
 * `paydividend <rate>` shows this preview and stores an `awaiting_dividend_confirm`
 * state; only an explicit `CONFIRM <rate>` executes it.
 */
export async function previewDividendRun(
  phone: string,
  rate: number,
  basis: DividendBasis = "savings",
): Promise<DividendRunPreview> {
  basis = normalizeBasis(basis);
  const admin = await prisma.member.findFirst({ where: { phone, role: "superadmin" } });
  if (!admin) return { ok: false, message: "Only the super admin can distribute dividends." };
  if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_DIVIDEND_RATE) {
    return { ok: false, message: `Rate must be between 0 and ${MAX_DIVIDEND_RATE}.` };
  }

  const base = await computeDividendBase(admin.cooperativeId);
  if (base.netProfit <= 0) {
    return {
      ok: false,
      message: `There's no profit to share yet (net: ${formatBalance(base.netProfit)}).`,
    };
  }
  if (base.remaining <= 0) {
    return {
      ok: false,
      message: `No undistributed profit left this period (net ${formatBalance(base.netProfit)} is already fully appropriated and declared).`,
    };
  }

  const members = await prisma.member.findMany({
    where: { cooperativeId: admin.cooperativeId },
    select: {
      id: true,
      bankAccountNumber: true,
      bankCode: true,
      wallet: { select: { totalSaved: true } },
      shareAccount: { select: { shares: true } },
    },
  });
  const totalWeight = members.reduce((sum, m) => sum + weightOf(m, basis), 0);
  if (totalWeight <= 0) {
    return {
      ok: false,
      message:
        basis === "shares"
          ? "No shares have been issued yet — nothing to distribute against."
          : "No savings yet — nothing to distribute against.",
    };
  }

  // Statutory 20/2/5% is appropriated at most ONCE per period; a later run in
  // the same period shares the same profit base and takes no statutory again.
  const takeStatutory = base.statutoryTakenThisPeriod === 0;
  const statutoryAmount = takeStatutory
    ? roundMoney(
        Math.floor(base.netProfit * RESERVE_FUND_RATE) +
          Math.floor(base.netProfit * EDUCATION_FUND_RATE) +
          Math.floor(base.netProfit * DEVELOPMENT_FUND_RATE),
      )
    : 0;
  const distributable = Math.max(0, roundMoney(base.remaining - statutoryAmount));
  const pool = Math.max(0, Math.round(distributable * (rate / 100)));
  if (pool <= 0) {
    return {
      ok: false,
      message: `After statutory deductions there's no distributable profit left.`,
    };
  }

  const shares = allocateShares(members, pool, basis);
  const payable = members.filter((m) => (shares.get(m.id) ?? 0) > 0);
  const withBank = payable.filter((m) => Boolean(m.bankAccountNumber && m.bankCode));
  const payoutCount = withBank.length;
  const heldCount = payable.length - payoutCount;
  const totalPayout = roundMoney(withBank.reduce((sum, m) => sum + (shares.get(m.id) ?? 0), 0));

  const bankFloat = await getBankAccountBalance(admin.cooperativeId);
  if (totalPayout > bankFloat) {
    return {
      ok: false,
      message: `🛑 Insufficient bank float. This run needs ${formatBalance(totalPayout)} but the bank account holds ${formatBalance(bankFloat)} (per the books).`,
    };
  }

  const confirmToken = `CONFIRM ${rate}`;
  const label = basis === "shares" ? "share dividend run" : "dividend run";
  const audience = basis === "shares" ? "shareholders" : "members";
  const message =
    `⚠️ *Confirm ${label}*\n\n` +
    `Rate: *${rate}%* of net profit ${formatBalance(base.netProfit)}\n` +
    `${audience} pool: *${formatBalance(pool)}*\n` +
    `Direct bank payouts: *${payoutCount}* ${audience}\n` +
    (heldCount > 0 ? `Held (no verified bank account): *${heldCount}*\n` : ``) +
    `Bank float: *${formatBalance(bankFloat)}*\n\n` +
    `This sends real money to ${payoutCount} bank account(s) and cannot be undone.\n\n` +
    `Reply *${confirmToken}* to proceed, or *cancel* (this expires with the session).`;

  return { ok: true, message, confirmToken, pool, payoutCount, heldCount, bankFloat };
}

/**
 * Execute a previously-previewed dividend run and record the governance
 * bookkeeping (last rate, close any approved rate vote). Called only from the
 * `awaiting_dividend_confirm` state machine after an explicit confirmation.
 */
export async function confirmDividendDistribution(
  phone: string,
  rate: number,
  basis: DividendBasis = "savings",
): Promise<DividendRunResult> {
  basis = normalizeBasis(basis);
  const result = await distributeDividend(phone, rate, basis);
  if (!result.ok) return result;

  if (basis === "savings") {
    const admin = await prisma.member.findFirst({ where: { phone, role: "superadmin" } });
    if (admin) {
      await updateCoopConfig(admin.cooperativeId, {
        lastDividendRate: rate,
        pendingDividendRate: null,
      } as any).catch(() => {});
      const approvedVote = await prisma.dividendVote.findFirst({
        where: { cooperativeId: admin.cooperativeId, proposedRate: rate, status: "approved" },
        orderBy: { closedAt: "desc" },
      });
      if (approvedVote) {
        await prisma.dividendVote.updateMany({
          where: { id: approvedVote.id },
          data: { status: "closed", closedById: admin.id, closedAt: new Date() },
        });
      }
    }
  }
  return result;
}

export async function distributeDividend(
  phone: string,
  rate: number,
  basis: DividendBasis = "savings",
): Promise<DividendRunResult> {
  basis = normalizeBasis(basis);
  const admin = await prisma.member.findFirst({ where: { phone, role: "superadmin" } });
  if (!admin) {
    return { ok: false, message: "Only the super admin can pay dividends." };
  }
  if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_DIVIDEND_RATE) {
    const cmd = basis === "shares" ? "paysharedividend" : "paydividend";
    return {
      ok: false,
      message: `Rate must be between 0 and ${MAX_DIVIDEND_RATE}, e.g. *${cmd} 20* pays 20% of profit.`,
    };
  }

  const base = await computeDividendBase(admin.cooperativeId);
  if (base.netProfit <= 0) {
    return {
      ok: false,
      message:
        `There's no profit to share yet (net: ${formatBalance(base.netProfit)}).\n` +
        `Profit comes from loan interest, fines and admin charges, minus salaries and payments.`,
    };
  }
  if (base.remaining <= 0) {
    return {
      ok: false,
      message: `No undistributed profit left this period (net ${formatBalance(base.netProfit)} is already fully appropriated and declared).`,
    };
  }

  const members = await prisma.member.findMany({
    where: { cooperativeId: admin.cooperativeId },
    select: {
      id: true,
      name: true,
      phone: true,
      bankAccountNumber: true,
      bankCode: true,
      bankName: true,
      bankAccountName: true,
      wallet: { select: { totalSaved: true } },
      shareAccount: { select: { shares: true } },
    },
  });
  const totalWeight = members.reduce((sum, m) => sum + weightOf(m, basis), 0);
  if (totalWeight <= 0) {
    return {
      ok: false,
      message:
        basis === "shares"
          ? "No shares have been issued yet — nothing to distribute against."
          : "No savings yet — nothing to distribute against.",
    };
  }

  // Statutory 20/2/5% is appropriated at most ONCE per period.
  const takeStatutory = base.statutoryTakenThisPeriod === 0;
  const reserveAmount = takeStatutory ? Math.floor(base.netProfit * RESERVE_FUND_RATE) : 0;
  const educationAmount = takeStatutory ? Math.floor(base.netProfit * EDUCATION_FUND_RATE) : 0;
  const developmentAmount = takeStatutory ? Math.floor(base.netProfit * DEVELOPMENT_FUND_RATE) : 0;
  const totalDeductions = roundMoney(reserveAmount + educationAmount + developmentAmount);
  const distributableProfit = Math.max(0, roundMoney(base.remaining - totalDeductions));
  const pool = Math.max(0, Math.round(distributableProfit * (rate / 100)));
  if (pool <= 0) {
    return {
      ok: false,
      message:
        `After statutory deductions (${formatBalance(totalDeductions)}), there's no distributable profit left (${formatBalance(distributableProfit)}). ` +
        `Try a higher dividend rate or wait for more profit.`,
    };
  }

  const shares = allocateShares(members, pool, basis);
  const payable = members.filter((m) => (shares.get(m.id) ?? 0) > 0);
  const candidates = payable.filter((m) => Boolean(m.bankAccountNumber && m.bankCode));
  const held = payable.filter((m) => !(m.bankAccountNumber && m.bankCode));
  const totalPayout = roundMoney(candidates.reduce((sum, m) => sum + (shares.get(m.id) ?? 0), 0));

  // ---- Bulk guard: never launch an unbounded fan-out ----
  if (candidates.length > DIVIDEND_MAX_PAYOUTS_PER_RUN) {
    return {
      ok: false,
      message:
        `This run would pay *${candidates.length}* members, above the per-run ceiling of ${DIVIDEND_MAX_PAYOUTS_PER_RUN}. ` +
        `Raise DIVIDEND_MAX_PAYOUTS_PER_RUN or run in batches.`,
    };
  }

  // ---- Explicit balance check against the JOURNAL-DERIVED bank float ----
  const bankFloat = await getBankAccountBalance(admin.cooperativeId);
  if (totalPayout > bankFloat) {
    return {
      ok: false,
      message:
        `🛑 Insufficient bank float. This run needs ${formatBalance(totalPayout)} but the cooperative bank account holds ${formatBalance(bankFloat)} (per the books). ` +
        `Lower the rate or top up the bank account.`,
    };
  }

  const reference = `DIV-${Date.now()}`;

  // =====================================================================
  // SAGA STEP 1 — ATOMIC DB CLAIM + BALANCED JOURNALS. NO network call here.
  // =====================================================================
  const dividend = await withTx(async (tx) => {
    // Scope the transaction to this cooperative's RLS context. No-op on SQLite;
    // with the RLS policies applied this restricts every query below.
    await setCoopContext(tx as never, admin.cooperativeId);
    const d = await tx.dividend.create({
      data: {
        cooperativeId: admin.cooperativeId,
        reference,
        rate,
        basis,
        totalPool: pool,
        status: "distributing",
        entries: {
          create: payable.map((m) => {
            const isCandidate = Boolean(m.bankAccountNumber && m.bankCode);
            return {
              memberId: m.id,
              amount: shares.get(m.id) ?? 0,
              status: isCandidate ? "processing" : "pending",
              failureReason: isCandidate ? null : "No verified bank account on file",
            };
          }),
        },
      },
    });

    // Statutory funds: internal appropriation, no bank movement.
    if (takeStatutory) {
      await tx.reserveAllocation.create({
        data: {
          cooperativeId: admin.cooperativeId,
          amount: reserveAmount,
          source: "dividend_declaration",
          referenceId: reference,
          note: `20% statutory reserve from dividend at ${rate}% of net profit`,
        },
      });
      await tx.educationFund.create({
        data: {
          cooperativeId: admin.cooperativeId,
          amount: educationAmount,
          source: "dividend_declaration",
          referenceId: reference,
          note: `2% education fund from dividend at ${rate}% of net profit`,
        },
      });
      await tx.developmentFund.create({
        data: {
          cooperativeId: admin.cooperativeId,
          amount: developmentAmount,
          source: "dividend_declaration",
          referenceId: reference,
          note: `5% development fund from dividend at ${rate}% of net profit`,
        },
      });
      await tx.cooperative.update({
        where: { id: admin.cooperativeId },
        data: { reserveFundBalance: { increment: reserveAmount } },
      });
    }

    if (totalDeductions > 0) {
      await postJournal(
        {
          cooperativeId: admin.cooperativeId,
          txRef: `DIV-STAT-${d.id}`,
          description: `Statutory deductions from dividend ${d.id.slice(-6)}`,
          postings: [
            {
              account: "appropriation:statutory_funds",
              direction: "DEBIT",
              amount: totalDeductions,
            },
            { account: "liabilities:reserve_fund", direction: "CREDIT", amount: totalDeductions },
          ],
        },
        tx as any,
      );
    }

    // Declaration: move appropriated profit into the members' dividend payable.
    await postJournal(
      {
        cooperativeId: admin.cooperativeId,
        txRef: `DIV-DECL-${d.id}`,
        description: `Dividend declaration ${d.id.slice(-6)} at ${rate}%`,
        postings: [
          { account: "appropriation:dividend", direction: "DEBIT", amount: pool },
          { account: "liabilities:dividend_payable", direction: "CREDIT", amount: pool },
        ],
      },
      tx as any,
    );

    // Per-member payout legs (bank out), committed atomically with the claim so
    // a crash before settlement leaves a reversible, balanced entry.
    for (const m of candidates) {
      const amount = shares.get(m.id) ?? 0;
      await postJournal(
        {
          cooperativeId: admin.cooperativeId,
          txRef: dividendPayoutRef(d.id, m.id),
          description: `Dividend payout to ${m.name} (${d.id.slice(-6)})`,
          postings: [
            { account: "liabilities:dividend_payable", direction: "DEBIT", amount },
            { account: "assets:bank", direction: "CREDIT", amount },
          ],
        },
        tx as any,
      );
    }

    return d;
  });

  // =====================================================================
  // SAGA STEP 2 — call the gateway OUTSIDE the transaction, then settle/compensate.
  // =====================================================================
  let settled = 0;
  let failed = 0;

  await runPool(candidates, DIVIDEND_PAYOUT_CONCURRENCY, async (m) => {
    const amount = shares.get(m.id) ?? 0;
    const result = await sendToBank({
      memberId: m.id,
      amount,
      bankAccountNumber: m.bankAccountNumber!,
      bankCode: m.bankCode!,
      bankName: m.bankName ?? undefined,
      note: `Dividend ${reference} to ${m.name}`,
      idempotencyKey: dividendPayoutRef(dividend.id, m.id),
      // The dividend already posted its own balanced pair above.
      suppressJournal: true,
      successMessage: `🎉 *Dividend paid!* ${formatBalance(amount)} has been sent to your bank account (${m.bankName ?? m.bankCode} ****${m.bankAccountNumber!.slice(-4)}).`,
      onFailure: async (_status, error) => {
        await prisma.dividendEntry
          .updateMany({
            where: { dividendId: dividend.id, memberId: m.id },
            data: { failureReason: error.slice(0, 300) },
          })
          .catch(() => {});
      },
    });

    if (result.ok) {
      await prisma.dividendEntry.updateMany({
        where: { dividendId: dividend.id, memberId: m.id },
        data: { status: "settled", paidAt: new Date(), payoutId: result.payoutId },
      });
      // Persist the provider-verified account name once (Zero-BVN assurance).
      if (result.verifiedName && !m.bankAccountName) {
        await prisma.member
          .update({ where: { id: m.id }, data: { bankAccountName: result.verifiedName } })
          .catch(() => {});
      }
      settled++;
      return;
    }

    if (result.status === "unsure") {
      // Ambiguous: the transfer may have been submitted. NEVER reverse here or
      // the coop could reverse a payment that actually landed (double loss).
      await alertSupers(
        admin.cooperativeId,
        `Dividend payout ${reference} for *${m.name}* has an *unconfirmed* outcome. Reconcile with the provider before reversing.`,
        AlertSeverity.CRITICAL,
      ).catch(() => {});
      return;
    }

    // Confirmed failure (failed | name_mismatch) → reverse the bank-out journal.
    await reverseDividendJournal(admin.cooperativeId, dividend.id, m.id, amount);
    await prisma.dividendEntry.updateMany({
      where: { dividendId: dividend.id, memberId: m.id },
      data: {
        status: "failed",
        failureReason: `${result.status}: ${result.message}`.slice(0, 300),
      },
    });
    failed++;
  });

  // ---- Wrap up ----
  await prisma.dividend.update({
    where: { id: dividend.id },
    data: { status: "distributed", distributedAt: new Date() },
  });

  // Tell held members how to get paid; the liability stays on the books.
  for (const m of held) {
    await notifyMember(
      m,
      `🎉 You have a dividend of *${formatBalance(shares.get(m.id) ?? 0)}* waiting, but no verified bank account is on file.\n\n` +
        `Reply *withdraw <amount> <account number> <bank>* once to register a bank account, and the next dividend run (or an admin) will pay it out.`,
    ).catch(() => {});
  }

  await audit({
    cooperativeId: admin.cooperativeId,
    actorPhone: admin.phone,
    actorId: admin.id,
    actorRole: admin.role,
    action: "dividend.distribute",
    targetType: "dividend",
    targetId: dividend.id,
    amount: pool,
    detail: `Dividend distribution of ${formatBalance(pool)}: settled ${settled}, held ${held.length}, failed ${failed}`,
  }).catch(() => {});

  const poolLabel = basis === "shares" ? "Shareholders pool" : "Member pool";
  const summary =
    `🎉 *Dividend run ${dividend.id.slice(-6)} complete*\n\n` +
    `Rate: *${rate}%* of net profit ${formatBalance(base.netProfit)}\n` +
    `${poolLabel}: *${formatBalance(pool)}*\n` +
    `Statutory deductions: *${formatBalance(totalDeductions)}*\n\n` +
    `✅ Paid to bank: *${settled}* member(s)\n` +
    `⏸️ Held (no bank account): *${held.length}*\n` +
    `⚠️ Failed (reversed): *${failed}*`;

  await notifySuperAdmins(admin.cooperativeId, summary).catch(() => {});

  return {
    ok: true,
    message: summary,
    dividendId: dividend.id,
    settled,
    held: held.length,
    failed,
    totalPool: pool,
  };
}

/**
 * Reverse a dividend payout's bank-out journal. Idempotent on txRef, so the
 * inline failure path and the async webhook can both call it safely.
 */
export async function reverseDividendJournal(
  cooperativeId: string,
  dividendId: string,
  memberId: string,
  amount: number,
): Promise<{ posted: boolean; reason?: string }> {
  return postJournal({
    cooperativeId,
    txRef: `DIV-REV-${dividendId}-${memberId}`,
    description: `Reversal of dividend payout ${dividendId.slice(-6)} to ${memberId.slice(-6)}`,
    postings: [
      { account: "assets:bank", direction: "DEBIT", amount },
      { account: "liabilities:dividend_payable", direction: "CREDIT", amount },
    ],
  });
}

// ---------------------------------------------------------------------------
// Async transfer-callback saga
// ---------------------------------------------------------------------------

export interface PayoutUpdate {
  provider: string;
  /** Payout.idempotencyKey / provider reference we sent. */
  reference: string;
  status: "successful" | "failed";
  providerRef?: string;
}

/**
 * Settle or reverse a dividend payout in response to a provider transfer
 * callback. Idempotent and safe to call for any payout (ignores non-dividend
 * payouts). `transfer.success` marks the entry settled; `transfer.failed`
 * reverses the journal. Ambiguous statuses are the caller's responsibility to
 * route to "investigating" and must never reach the reverse branch.
 */
export async function applyDividendPayoutUpdate(
  update: PayoutUpdate,
): Promise<{ handled: boolean; action?: "settled" | "reversed" | "noop" }> {
  // Resolve the cooperative from the payout reference (SECURITY DEFINER
  // resolver bypasses RLS) before reading the RLS-protected Payout table.
  const coopId = await resolveCoopByPayoutReference(update.reference);
  if (!coopId) return { handled: false };

  return withCoopContext(coopId, async () => {
  const payout = await prisma.payout.findUnique({
    where: { idempotencyKey: update.reference },
    include: { dividendEntry: true },
  });
  if (!payout || !payout.dividendEntry) return { handled: false };

  const entry = payout.dividendEntry;

  if (update.status === "successful") {
    if (entry.status !== "settled") {
      await withTxBatch([
        prisma.dividendEntry.update({
          where: { id: entry.id },
          data: { status: "settled", paidAt: new Date() },
        }),
        prisma.payout.update({
          where: { id: payout.id },
          data: { status: "successful", providerRef: update.providerRef ?? payout.providerRef },
        }),
      ]);
    }
    return { handled: true, action: "settled" };
  }

  // status === "failed" — only reverse if not already finalised.
  if (entry.status === "failed" || entry.status === "reversed") {
    return { handled: true, action: "noop" };
  }
  await reverseDividendJournal(
    payout.cooperativeId,
    entry.dividendId,
    entry.memberId,
    entry.amount,
  );
  await withTxBatch([
    prisma.dividendEntry.update({
      where: { id: entry.id },
      data: { status: "failed", failureReason: "Provider reported transfer.failed" },
    }),
    prisma.payout.update({ where: { id: payout.id }, data: { status: "failed" } }),
  ]);
  return { handled: true, action: "reversed" };
  });
}

// ---------------------------------------------------------------------------
// Fund balances / reserve info
// ---------------------------------------------------------------------------

/**
 * Get fund balances for a cooperative.
 *
 * NOTE: Reserve fund uses the denormalized `coop.reserveFundBalance` column,
 * while education/development are aggregated from their transaction tables.
 * A periodic reconciliation job should verify the denormalized balance matches.
 */
export async function getFundBalances(cooperativeId: string): Promise<{
  reserve: number;
  education: number;
  development: number;
}> {
  const [reserveTotal, educationTotal, developmentTotal] = await Promise.all([
    prisma.reserveAllocation.aggregate({ where: { cooperativeId }, _sum: { amount: true } }),
    prisma.educationFund.aggregate({ where: { cooperativeId }, _sum: { amount: true } }),
    prisma.developmentFund.aggregate({ where: { cooperativeId }, _sum: { amount: true } }),
  ]);

  const reserveBalance = reserveTotal._sum.amount ?? 0;

  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });
  const reported = coop?.reserveFundBalance ?? 0;
  if (Math.abs(reported - reserveBalance) > 1) {
    console.warn(
      `[compliance] Reserve fund divergence: reported ${reported}, actual ${reserveBalance}`,
    );
    await prisma.cooperative.update({
      where: { id: cooperativeId },
      data: { reserveFundBalance: reserveBalance },
    });
  }

  return {
    reserve: reserveBalance,
    education: educationTotal._sum.amount ?? 0,
    development: developmentTotal._sum.amount ?? 0,
  };
}

/** Get reserve fund info for members */
export async function getReserveInfo(cooperativeId: string): Promise<{
  balance: number;
  thisQuarter: number;
  lastQuarter: number;
  growthPercent: number;
}> {
  const reserveAgg = await prisma.reserveAllocation.aggregate({
    where: { cooperativeId },
    _sum: { amount: true },
  });
  const balance = reserveAgg._sum.amount ?? 0;

  const now = new Date();
  const thisQuarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  const lastQuarterStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 - 3, 1);

  const [thisQuarter, lastQuarter] = await Promise.all([
    prisma.reserveAllocation.aggregate({
      where: { cooperativeId, createdAt: { gte: thisQuarterStart } },
      _sum: { amount: true },
    }),
    prisma.reserveAllocation.aggregate({
      where: { cooperativeId, createdAt: { gte: lastQuarterStart, lt: thisQuarterStart } },
      _sum: { amount: true },
    }),
  ]);

  const thisQ = thisQuarter._sum.amount ?? 0;
  const lastQ = lastQuarter._sum.amount ?? 0;
  const growthPercent = lastQ > 0 ? Math.round(((thisQ - lastQ) / lastQ) * 100) : 0;

  return { balance, thisQuarter: thisQ, lastQuarter: lastQ, growthPercent };
}
