import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit.js";

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

import { withCoopContext, getCoopMeta } from "../../lib/tenant-context.js";
import { postJournal } from "../journal.js";
import { postFederationJournal } from "./ledger.js";
import { getRate } from "./fx.js";

export async function contribute(federationId: string, cooperativeId: string, amountKobo: number): Promise<void> {
  const { currency } = await getCoopMeta(cooperativeId);
  const fed = await prisma.federation.findUniqueOrThrow({ where: { id: federationId } });
  const rate = await getRate(federationId, currency, fed.baseCurrency);
  const baseAmount = Math.round(amountKobo * rate);
  const ref = `FED-CONTRIB-${federationId}-${cooperativeId}-${Date.now()}`;

  await withCoopContext(cooperativeId, async () => {
    const claimed = await prisma.cooperative.updateMany({
      where: { id: cooperativeId, federationFundBalance: { gte: amountKobo } },
      data: { federationFundBalance: { decrement: amountKobo } },
    });
    if (claimed.count === 0) throw new Error("INSUFFICIENT_BALANCE");
    await postJournal({
      cooperativeId,
      txRef: ref,
      description: `Federation pool contribution`,
      postings: [
        { account: "federation:receivable", direction: "DEBIT", amount: amountKobo },
        { account: "coop:federation_fund", direction: "CREDIT", amount: amountKobo },
      ],
    });
    await postFederationJournal({
      federationId,
      txRef: ref,
      description: `Pool contribution from coop ${cooperativeId}`,
      currency: fed.baseCurrency,
      postings: [
        { account: "assets:bank", direction: "DEBIT", amount: baseAmount },
        { account: `coop:${cooperativeId}:payable`, direction: "CREDIT", amount: baseAmount, cooperativeId },
      ],
    });
  });
  await audit({ cooperativeId, actorPhone: "system", action: "federation.contribute", targetType: "federation", targetId: federationId, amount: amountKobo, detail: `contributed ${amountKobo} ${currency}` });
}

export async function borrow(federationId: string, cooperativeId: string, amountKobo: number, termMonths: number, lenderCooperativeId?: string) {
  const { currency } = await getCoopMeta(cooperativeId);
  const fed = await prisma.federation.findUniqueOrThrow({ where: { id: federationId } });
  const rate = await getRate(federationId, currency, fed.baseCurrency);
  const baseAmount = Math.round(amountKobo * rate);
  const dueAt = new Date(Date.now() + termMonths * 30 * 24 * 60 * 60 * 1000);
  const loan = await prisma.federationLoan.create({
    data: { federationId, lenderCooperativeId: lenderCooperativeId ?? null, borrowerCooperativeId: cooperativeId, principalKobo: amountKobo, currency, fxRateToBase: rate, interestRate: 0.12, termMonths, status: "active", disbursedAt: new Date(), dueAt },
  });
  const ref = `FED-LOAN-${loan.id}`;
  await withCoopContext(cooperativeId, async () => {
    await prisma.cooperative.update({
      where: { id: cooperativeId },
      data: { federationFundBalance: { increment: amountKobo } },
    });
    await postJournal({
      cooperativeId,
      txRef: ref,
      description: `Federation loan disbursement`,
      postings: [
        { account: "coop:federation_fund", direction: "DEBIT", amount: amountKobo },
        { account: "federation:payable", direction: "CREDIT", amount: amountKobo },
      ],
    });
    await postFederationJournal({
      federationId,
      txRef: ref,
      description: `Loan to coop ${cooperativeId}`,
      currency: fed.baseCurrency,
      postings: [
        { account: `coop:${cooperativeId}:receivable`, direction: "DEBIT", amount: baseAmount, cooperativeId },
        { account: "assets:bank", direction: "CREDIT", amount: baseAmount },
      ],
    });
  });
  await audit({ cooperativeId, actorPhone: "system", action: "federation.borrow", targetType: "federation_loan", targetId: loan.id, amount: amountKobo, detail: `borrowed ${amountKobo} ${currency} for ${termMonths}m` });
  return loan;
}

export async function repay(loanId: string, amountKobo: number): Promise<void> {
  const loan = await prisma.federationLoan.findUniqueOrThrow({ where: { id: loanId } });
  const cooperativeId = loan.borrowerCooperativeId;
  const fed = await prisma.federation.findUniqueOrThrow({ where: { id: loan.federationId } });
  const baseAmount = Math.round(amountKobo * loan.fxRateToBase);
  const ref = `FED-REPAY-${loanId}-${Date.now()}`;
  await withCoopContext(cooperativeId, async () => {
    const claimed = await prisma.cooperative.updateMany({
      where: { id: cooperativeId, federationFundBalance: { gte: amountKobo } },
      data: { federationFundBalance: { decrement: amountKobo } },
    });
    if (claimed.count === 0) throw new Error("INSUFFICIENT_BALANCE");
    await postJournal({
      cooperativeId,
      txRef: ref,
      description: `Federation loan repayment`,
      postings: [
        { account: "federation:payable", direction: "DEBIT", amount: amountKobo },
        { account: "coop:federation_fund", direction: "CREDIT", amount: amountKobo },
      ],
    });
    await postFederationJournal({
      federationId: loan.federationId,
      txRef: ref,
      description: `Repayment from coop ${cooperativeId}`,
      currency: fed.baseCurrency,
      postings: [
        { account: "assets:bank", direction: "DEBIT", amount: baseAmount },
        { account: `coop:${cooperativeId}:receivable`, direction: "CREDIT", amount: baseAmount, cooperativeId },
      ],
    });
  });
  const repaid = loan.repaidKobo + amountKobo;
  await prisma.federationLoan.update({
    where: { id: loanId },
    data: { repaidKobo: repaid, status: repaid >= loan.principalKobo ? "repaid" : "active" },
  });
  await prisma.federationLoanRepayment.create({
    data: { loanId, amountKobo, currency: loan.currency, fxRateToBase: loan.fxRateToBase },
  });
  await audit({ cooperativeId, actorPhone: "system", action: "federation.repay", targetType: "federation_loan", targetId: loanId, amount: amountKobo, detail: `repaid ${amountKobo} ${loan.currency}` });
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
