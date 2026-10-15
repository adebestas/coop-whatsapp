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

/** Simple interest over the term, in the loan's (minor-unit) currency. */
export function computeInterest(
  principalKobo: number,
  interestRate: number,
  termMonths: number,
): number {
  return Math.round((principalKobo * interestRate * termMonths) / 12);
}

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
          { account: "federation:fund", direction: "DEBIT", amount: amountKobo },
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

  const poolBalance = await getPoolBalance(federationId);
  if (baseAmount > poolBalance) throw new Error("INSUFFICIENT_POOL_LIQUIDITY");

  if (lenderCooperativeId) {
    const { stakeKobo } = await getPosition(federationId, lenderCooperativeId);
    if (stakeKobo < amountKobo) throw new Error("INSUFFICIENT_LENDER_STAKE");
  }

  const dueAt = new Date(Date.now() + termMonths * 30 * 24 * 60 * 60 * 1000);
  const loan = await withCoopContext(cooperativeId, () =>
    prisma.federationLoan.create({
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
    }),
  );

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
  if (loan.status !== "pending") return;
  const cooperativeId = loan.borrowerCooperativeId;
  const fed = await prisma.federation.findUniqueOrThrow({ where: { id: loan.federationId } });
  const baseAmount = Math.round(loan.principalKobo * loan.fxRateToBase);

  const poolBalance = await getPoolBalance(loan.federationId);
  if (baseAmount > poolBalance) throw new Error("INSUFFICIENT_POOL_LIQUIDITY");

  const ref = `FED-LOAN-${loan.id}-${randomUUID()}`;
  await withCoopContext(cooperativeId, async () => {
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
    await prisma.federationLoan.update({
      where: { id: loanId },
      data: { status: "active", disbursedAt: new Date() },
    });
  });
  await audit({
    cooperativeId,
    actorPhone: "system",
    action: "federation.loan.approve",
    targetType: "federation_loan",
    targetId: loanId,
    detail: "loan approved and disbursed",
  });
}

export async function repay(loanId: string, amountKobo: number): Promise<void> {
  if (!(amountKobo > 0)) throw new Error("INVALID_AMOUNT");
  const loan = await prisma.federationLoan.findUniqueOrThrow({ where: { id: loanId } });
  const cooperativeId = loan.borrowerCooperativeId;
  const fed = await prisma.federation.findUniqueOrThrow({ where: { id: loan.federationId } });
  const baseAmount = Math.round(amountKobo * loan.fxRateToBase);
  const ref = `FED-REPAY-${loanId}-${randomUUID()}`;
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
    const fresh = await prisma.federationLoan.findUniqueOrThrow({ where: { id: loanId } });
    const repaid = fresh.repaidKobo + amountKobo;
    const fullyRepaid = fresh.status === "active" && repaid >= fresh.principalKobo;
    await prisma.federationLoan.update({
      where: { id: loanId },
      data: { repaidKobo: repaid, status: fullyRepaid ? "repaid" : "active" },
    });
    await prisma.federationLoanRepayment.create({
      data: { loanId, amountKobo, currency: loan.currency, fxRateToBase: loan.fxRateToBase },
    });

    if (fullyRepaid) {
      const interest = computeInterest(fresh.principalKobo, fresh.interestRate, fresh.termMonths);
      if (interest > 0) {
        const interestBase = Math.round(interest * loan.fxRateToBase);
        const interestRef = `FED-INTEREST-${loanId}-${randomUUID()}`;
        assertPosted(
          await postJournal({
            cooperativeId,
            txRef: interestRef,
            description: `Federation loan interest`,
            postings: [
              { account: "federation:payable", direction: "DEBIT", amount: interest },
              { account: "federation:fund", direction: "CREDIT", amount: interest },
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
                account: loan.lenderCooperativeId ? "federation:interest_income" : "pool:liquidity",
                direction: "CREDIT",
                amount: interestBase,
                cooperativeId: loan.lenderCooperativeId ?? null,
              },
            ],
          }),
        );
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
  return { stakeKobo, owedKobo };
}
