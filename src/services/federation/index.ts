import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit.js";
import { withCoopContext, getCoopMeta } from "../../lib/tenant-context.js";
import { postJournal } from "../journal.js";
import { postFederationJournal } from "./ledger.js";
import { getRate } from "./fx.js";
import { roundMoney } from "../money.js";

/**
 * A double-entry posting that silently no-ops (duplicate / unbalanced) would
 * let a money move land half-booked. Every federation move asserts the posting
 * actually happened; a `false` rolls the whole surrounding transaction back.
 */
function assertPosted(result: { posted: boolean; reason?: string }): void {
  if (!result.posted) throw new Error("journal not posted: " + result.reason);
}

export async function createFederation(name: string, code: string, baseCurrency: string) {
  return prisma.federation.create({ data: { name, code, baseCurrency } });
}

export async function addMember(federationId: string, cooperativeId: string) {
  const existing = await prisma.federationMembership.findUnique({
    where: { federationId_cooperativeId: { federationId, cooperativeId } },
  });
  if (existing) return existing;
  const m = await prisma.federationMembership.create({
    data: { federationId, cooperativeId, status: "active" },
  });
  await audit({
    cooperativeId,
    actorPhone: "system",
    action: "federation.member.add",
    targetType: "federation",
    targetId: federationId,
    detail: `coop ${cooperativeId} joined federation ${federationId}`,
  });
  return m;
}

export async function removeMember(federationId: string, cooperativeId: string): Promise<void> {
  await prisma.federationMembership.deleteMany({ where: { federationId, cooperativeId } });
  await audit({
    cooperativeId,
    actorPhone: "system",
    action: "federation.member.remove",
    targetType: "federation",
    targetId: federationId,
    detail: `coop ${cooperativeId} left federation ${federationId}`,
  });
}

export async function listFederationsForCoop(cooperativeId: string) {
  const memberships = await prisma.federationMembership.findMany({
    where: { cooperativeId, status: "active" },
    include: { federation: true },
  });
  return memberships.map((m) => m.federation);
}

/**
 * The federation's cash pool, derived from its platform-level ledger rather than
 * a denormalized column: assets:bank is DEBIT-normal, so
 *   poolBalance = Σ DEBIT(assets:bank) − Σ CREDIT(assets:bank)
 * over the federation's postings (all booked in the federation's base currency).
 * This is the precondition before any disbursement so the pool can never lend
 * out more cash than it actually holds.
 */
export async function getPoolBalance(federationId: string): Promise<number> {
  const rows = await prisma.federationPosting.groupBy({
    by: ["direction"],
    where: { entry: { federationId }, account: "assets:bank" },
    _sum: { amount: true },
  });
  const debits = roundMoney(rows.find((r) => r.direction === "DEBIT")?._sum.amount ?? 0);
  const credits = roundMoney(rows.find((r) => r.direction === "CREDIT")?._sum.amount ?? 0);
  return roundMoney(debits - credits);
}

/**
 * Simple interest accrued over the period the principal was actually
 * outstanding, in the loan's (minor-unit) currency. `elapsedMonths` defaults to
 * the full `termMonths` (fixed-term charge) and is always capped at the term, so
 * an early repayment costs less but a late one never costs more.
 */
export function computeInterest(
  principalKobo: number,
  interestRate: number,
  termMonths: number,
  elapsedMonths: number = termMonths,
): number {
  const months = Math.min(Math.max(elapsedMonths, 0), termMonths);
  return Math.round((principalKobo * interestRate * months) / 12);
}

/** Milliseconds per (30-day) month, used to prorate interest by elapsed time. */
const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

/**
 * Coop admin commits its own reserve capital into the federation fund. This is
 * the ONLY path that grows `federationFundBalance` — without it the fund could
 * only ever be drained. Guarded so the reserve can never go negative.
 */
export async function fundFederation(cooperativeId: string, amountKobo: number): Promise<void> {
  if (!(amountKobo > 0)) throw new Error("INVALID_AMOUNT");
  const ref = `FED-FUND-${randomUUID()}`;
  await withCoopContext(cooperativeId, async () => {
    const funded = await prisma.cooperative.updateMany({
      where: { id: cooperativeId, reserveFundBalance: { gte: amountKobo } },
      data: {
        reserveFundBalance: { decrement: amountKobo },
        federationFundBalance: { increment: amountKobo },
      },
    });
    if (funded.count === 0) throw new Error("INSUFFICIENT_RESERVE");
    assertPosted(
      await postJournal({
        cooperativeId,
        txRef: ref,
        description: "Federation fund",
        postings: [
          { account: "coop:federation_fund", direction: "DEBIT", amount: amountKobo },
          { account: "reserve:fund", direction: "CREDIT", amount: amountKobo },
        ],
      }),
    );
  });
  await audit({
    cooperativeId,
    actorPhone: "system",
    action: "federation.fund",
    targetType: "cooperative",
    targetId: cooperativeId,
    amount: amountKobo,
    detail: `funded federation fund with ${amountKobo}`,
  });
}

export async function contribute(
  federationId: string,
  cooperativeId: string,
  amountKobo: number,
): Promise<void> {
  if (!(amountKobo > 0)) throw new Error("INVALID_AMOUNT");
  const { currency } = await getCoopMeta(cooperativeId);
  const fed = await prisma.federation.findUniqueOrThrow({ where: { id: federationId } });
  const rate = await getRate(federationId, currency, fed.baseCurrency);
  const baseAmount = Math.round(amountKobo * rate);
  const ref = `FED-CONTRIB-${federationId}-${cooperativeId}-${randomUUID()}`;

  await withCoopContext(cooperativeId, async () => {
    const claimed = await prisma.cooperative.updateMany({
      where: { id: cooperativeId, federationFundBalance: { gte: amountKobo } },
      data: { federationFundBalance: { decrement: amountKobo } },
    });
    if (claimed.count === 0) throw new Error("INSUFFICIENT_BALANCE");
    assertPosted(
      await postJournal({
        cooperativeId,
        txRef: ref,
        description: `Federation pool contribution`,
        postings: [
          { account: "federation:receivable", direction: "DEBIT", amount: amountKobo },
          { account: "coop:federation_fund", direction: "CREDIT", amount: amountKobo },
        ],
      }),
    );
    assertPosted(
      await postFederationJournal({
        federationId,
        txRef: ref,
        description: `Pool contribution from coop ${cooperativeId}`,
        currency: fed.baseCurrency,
        postings: [
          { account: "assets:bank", direction: "DEBIT", amount: baseAmount },
          {
            account: `coop:${cooperativeId}:payable`,
            direction: "CREDIT",
            amount: baseAmount,
            cooperativeId,
          },
        ],
      }),
    );
  });
  await audit({
    cooperativeId,
    actorPhone: "system",
    action: "federation.contribute",
    targetType: "federation",
    targetId: federationId,
    amount: amountKobo,
    detail: `contributed ${amountKobo} ${currency}`,
  });
}

/**
 * Request an inter-coop / pool loan. NO money moves here — the loan is created
 * `pending` and only the federation admin's `approveLoan` disburses it. We still
 * fail fast on both preconditions (pool liquidity, and — when a lender is named —
 * the lender's available stake) so an impossible request is rejected up front.
 * A bilateral lender's stake is earmarked (reclassified) at request time.
 */
export async function borrow(
  federationId: string,
  cooperativeId: string,
  amountKobo: number,
  termMonths: number,
  lenderCooperativeId?: string,
) {
  if (!(amountKobo > 0)) throw new Error("INVALID_AMOUNT");
  const { currency } = await getCoopMeta(cooperativeId);
  const fed = await prisma.federation.findUniqueOrThrow({ where: { id: federationId } });
  const rate = await getRate(federationId, currency, fed.baseCurrency);
  const baseAmount = Math.round(amountKobo * rate);

  if (lenderCooperativeId) {
    // The lender's stake is denominated in the federation's BASE currency
    // (`getPosition` reads base-currency postings), so convert the requested
    // amount into base before comparing — otherwise a cross-currency bilateral
    // loan compares two different units.
    const { stakeKobo } = await getPosition(federationId, lenderCooperativeId);
    if (stakeKobo < baseAmount) throw new Error("INSUFFICIENT_LENDER_STAKE");
  }

  const dueAt = new Date(Date.now() + termMonths * 30 * 24 * 60 * 60 * 1000);
  const loan = await withCoopContext(cooperativeId, async () => {
    // The pool-liquidity guard is read from INSIDE the transaction so a
    // concurrent approval cannot over-disburse the same cash.
    const poolBalance = await getPoolBalance(federationId);
    if (baseAmount > poolBalance) throw new Error("INSUFFICIENT_POOL_LIQUIDITY");
    return prisma.federationLoan.create({
      data: {
        federationId,
        lenderCooperativeId: lenderCooperativeId ?? null,
        borrowerCooperativeId: cooperativeId,
        principalKobo: amountKobo,
        currency,
        fxRateToBase: rate,
        interestRate: 0.12,
        termMonths,
        status: "pending",
        dueAt,
      },
    });
  });

  if (lenderCooperativeId) {
    const ref = `FED-EARMARK-${loan.id}-${randomUUID()}`;
    await withCoopContext(lenderCooperativeId, async () => {
      assertPosted(
        await postJournal({
          cooperativeId: lenderCooperativeId,
          txRef: ref,
          description: `Federation loan earmark ${loan.id}`,
          postings: [
            { account: "federation:loan_receivable", direction: "DEBIT", amount: amountKobo },
            { account: "federation:receivable", direction: "CREDIT", amount: amountKobo },
          ],
        }),
      );
    });
  }

  await audit({
    cooperativeId,
    actorPhone: "system",
    action: "federation.borrow",
    targetType: "federation_loan",
    targetId: loan.id,
    amount: amountKobo,
    detail: `requested ${amountKobo} ${currency} for ${termMonths}m (pending approval)`,
  });
  return loan;
}

/**
 * Federal-admin approval: this is where the disbursement happens. Idempotent
 * (only a `pending` loan is acted on) and atomic — the fund increment, both
 * journals, and the status flip share one `withCoopContext` transaction, so a
 * failed posting leaves nothing half-booked and the loan still approvable.
 */
export async function approveLoan(loanId: string): Promise<void> {
  const loan = await prisma.federationLoan.findUniqueOrThrow({ where: { id: loanId } });
  const cooperativeId = loan.borrowerCooperativeId;
  const fed = await prisma.federation.findUniqueOrThrow({ where: { id: loan.federationId } });
  const baseAmount = Math.round(loan.principalKobo * loan.fxRateToBase);

  const ref = `FED-LOAN-${loan.id}-${randomUUID()}`;
  const approved = await withCoopContext(cooperativeId, async () => {
    // ATOMIC CLAIM FIRST: only ONE concurrent approval can move the loan from
    // `pending` to `active`. Every other racer sees `count === 0` and no-ops, so
    // the same loan can never be double-disbursed (which fresh per-call txRefs
    // would otherwise allow).
    const claimed = await prisma.federationLoan.updateMany({
      where: { id: loanId, status: "pending" },
      data: { status: "active", disbursedAt: new Date() },
    });
    if (claimed.count === 0) return false;
    // Read pool liquidity from WITHIN the transaction (and before the
    // disbursement) so a claim that can't be funded rolls the transition back —
    // the loan stays `pending` and remains approvable.
    const poolBalance = await getPoolBalance(loan.federationId);
    if (baseAmount > poolBalance) throw new Error("INSUFFICIENT_POOL_LIQUIDITY");
    await prisma.cooperative.update({
      where: { id: cooperativeId },
      data: { federationFundBalance: { increment: loan.principalKobo } },
    });
    assertPosted(
      await postJournal({
        cooperativeId,
        txRef: ref,
        description: `Federation loan disbursement`,
        postings: [
          { account: "coop:federation_fund", direction: "DEBIT", amount: loan.principalKobo },
          { account: "federation:payable", direction: "CREDIT", amount: loan.principalKobo },
        ],
      }),
    );
    assertPosted(
      await postFederationJournal({
        federationId: loan.federationId,
        txRef: ref,
        description: `Loan to coop ${cooperativeId}`,
        currency: fed.baseCurrency,
        postings: [
          {
            account: `coop:${cooperativeId}:receivable`,
            direction: "DEBIT",
            amount: baseAmount,
            cooperativeId,
          },
          { account: "assets:bank", direction: "CREDIT", amount: baseAmount },
        ],
      }),
    );
    return true;
  });
  if (!approved) return;
  await audit({
    cooperativeId,
    actorPhone: "system",
    action: "federation.loan.approve",
    targetType: "federation_loan",
    targetId: loanId,
    detail: "loan approved and disbursed",
  });
}

export async function repay(
  loanId: string,
  amountKobo: number,
  callerCooperativeId: string,
): Promise<void> {
  if (!(amountKobo > 0)) throw new Error("INVALID_AMOUNT");
  const loan = await prisma.federationLoan.findUniqueOrThrow({ where: { id: loanId } });
  // Only the borrowing cooperative may repay its own loan — otherwise any coop
  // admin could pass another coop's loanId and drain that coop's fund balance.
  if (loan.borrowerCooperativeId !== callerCooperativeId) throw new Error("NOT_YOUR_LOAN");
  const cooperativeId = loan.borrowerCooperativeId;
  const fed = await prisma.federation.findUniqueOrThrow({ where: { id: loan.federationId } });
  const baseAmount = Math.round(amountKobo * loan.fxRateToBase);
  const ref = `FED-REPAY-${loanId}-${randomUUID()}`;
  let interestShortfallKobo = 0;
  await withCoopContext(cooperativeId, async () => {
    // Only an `active` loan is repayable, checked against the freshly-read row
    // INSIDE the transaction. Without this, a `repaid` loan (whose repaidKobo
    // >= principal already) could be re-repaid, flipped back to `active`, and
    // the fund debited again — repeatably.
    const current = await prisma.federationLoan.findUniqueOrThrow({ where: { id: loanId } });
    if (current.status !== "active") throw new Error("LOAN_NOT_REPAYABLE");
    const claimed = await prisma.cooperative.updateMany({
      where: { id: cooperativeId, federationFundBalance: { gte: amountKobo } },
      data: { federationFundBalance: { decrement: amountKobo } },
    });
    if (claimed.count === 0) throw new Error("INSUFFICIENT_BALANCE");
    assertPosted(
      await postJournal({
        cooperativeId,
        txRef: ref,
        description: `Federation loan repayment`,
        postings: [
          { account: "federation:payable", direction: "DEBIT", amount: amountKobo },
          { account: "coop:federation_fund", direction: "CREDIT", amount: amountKobo },
        ],
      }),
    );
    assertPosted(
      await postFederationJournal({
        federationId: loan.federationId,
        txRef: ref,
        description: `Repayment from coop ${cooperativeId}`,
        currency: fed.baseCurrency,
        postings: [
          { account: "assets:bank", direction: "DEBIT", amount: baseAmount },
          {
            account: `coop:${cooperativeId}:receivable`,
            direction: "CREDIT",
            amount: baseAmount,
            cooperativeId,
          },
        ],
      }),
    );
    // Atomic increment — concurrent partial repays accumulate instead of losing
    // an update (which a re-read + absolute write would).
    const updated = await prisma.federationLoan.update({
      where: { id: loanId },
      data: { repaidKobo: { increment: amountKobo } },
    });
    const fullyRepaid = updated.repaidKobo >= updated.principalKobo;
    // Guarded transition: exactly ONE final repayment flips active -> repaid, so
    // interest is charged once even if two repays close the loan concurrently.
    const moved = await prisma.federationLoan.updateMany({
      where: { id: loanId, status: "active" },
      data: { status: fullyRepaid ? "repaid" : "active" },
    });
    await prisma.federationLoanRepayment.create({
      data: { loanId, amountKobo, currency: loan.currency, fxRateToBase: loan.fxRateToBase },
    });

    if (fullyRepaid && moved.count > 0) {
      // Interest accrues over the period the principal was actually outstanding
      // (capped at the term), so an early repayment costs less.
      const elapsedMonths = loan.disbursedAt
        ? (Date.now() - loan.disbursedAt.getTime()) / MS_PER_MONTH
        : updated.termMonths;
      const interest = computeInterest(
        updated.principalKobo,
        updated.interestRate,
        updated.termMonths,
        elapsedMonths,
      );
      if (interest > 0) {
        // Non-reverting: a full principal repayment must never roll back just
        // because the coop's fund can't cover the interest. Charge at most the
        // available fund; any shortfall is recorded as still owed.
        const coop = await prisma.cooperative.findUniqueOrThrow({ where: { id: cooperativeId } });
        const available = Math.max(0, coop.federationFundBalance);
        const chargeable = Math.min(interest, available);
        let charged = 0;
        if (chargeable > 0) {
          const interestClaimed = await prisma.cooperative.updateMany({
            where: { id: cooperativeId, federationFundBalance: { gte: chargeable } },
            data: { federationFundBalance: { decrement: chargeable } },
          });
          if (interestClaimed.count > 0) charged = chargeable;
        }
        if (charged > 0) {
          const interestBase = Math.round(charged * loan.fxRateToBase);
          const interestRef = `FED-INTEREST-${loanId}-${randomUUID()}`;
          assertPosted(
            await postJournal({
              cooperativeId,
              txRef: interestRef,
              description: `Federation loan interest`,
              postings: [
                { account: "federation:payable", direction: "DEBIT", amount: charged },
                { account: "coop:federation_fund", direction: "CREDIT", amount: charged },
              ],
            }),
          );
          assertPosted(
            await postFederationJournal({
              federationId: loan.federationId,
              txRef: interestRef,
              description: `Interest on loan ${loanId}`,
              currency: fed.baseCurrency,
              postings: [
                { account: "assets:bank", direction: "DEBIT", amount: interestBase },
                {
                  account: loan.lenderCooperativeId
                    ? "federation:interest_income"
                    : "pool:liquidity",
                  direction: "CREDIT",
                  amount: interestBase,
                  cooperativeId: loan.lenderCooperativeId ?? null,
                },
              ],
            }),
          );
        }
        interestShortfallKobo = interest - charged;
      }
    }
  });
  await audit({
    cooperativeId,
    actorPhone: "system",
    action: "federation.repay",
    targetType: "federation_loan",
    targetId: loanId,
    amount: amountKobo,
    detail: `repaid ${amountKobo} ${loan.currency}`,
  });
  if (interestShortfallKobo > 0) {
    await audit({
      cooperativeId,
      actorPhone: "system",
      action: "federation.interest.shortfall",
      targetType: "federation_loan",
      targetId: loanId,
      amount: interestShortfallKobo,
      detail: `interest shortfall ${interestShortfallKobo} ${loan.currency} left unpaid after full repayment`,
    });
  }
}

export async function markDefaulted(loanId: string): Promise<void> {
  const loan = await prisma.federationLoan.findUniqueOrThrow({ where: { id: loanId } });
  await prisma.federationLoan.update({ where: { id: loanId }, data: { status: "defaulted" } });
  await audit({
    cooperativeId: loan.borrowerCooperativeId,
    actorPhone: "system",
    action: "federation.loan.default",
    targetType: "federation_loan",
    targetId: loanId,
    detail: "loan marked defaulted (manual remedy)",
  });
}

export async function getPosition(federationId: string, cooperativeId: string) {
  const entries = await prisma.federationPosting.findMany({
    where: { cooperativeId, entry: { federationId } },
  });
  let stakeKobo = 0;
  let owedKobo = 0;
  for (const p of entries) {
    const signed = p.direction === "DEBIT" ? p.amount : -p.amount;
    if (p.account.endsWith(":payable")) stakeKobo -= signed;
    if (p.account.endsWith(":receivable")) owedKobo += signed;
  }
  // A bilateral lender's stake is earmarked when it backs a loan, but the
  // earmark is posted on the LENDER's own coop journal (`federation:loan_receivable`),
  // which the federation ledger cannot see. Subtract the outstanding base-currency
  // principal of this coop's pending/active/defaulted loans so the same stake
  // cannot back unlimited loans (i.e. `stakeKobo` is the AVAILABLE, un-earmarked
  // stake). A `defaulted` loan keeps its earmark until the federation admin
  // writes it off — otherwise a default would silently free the lender's capital.
  const earmarked = await prisma.federationLoan.findMany({
    where: {
      federationId,
      lenderCooperativeId: cooperativeId,
      status: { in: ["pending", "active", "defaulted"] },
    },
    select: { principalKobo: true, fxRateToBase: true },
  });
  const earmarkedBase = earmarked.reduce(
    (sum, l) => sum + Math.round(l.principalKobo * l.fxRateToBase),
    0,
  );
  return { stakeKobo: roundMoney(stakeKobo - earmarkedBase), owedKobo };
}
