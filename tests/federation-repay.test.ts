import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma.js";
import {
  createFederation,
  addMember,
  contribute,
  borrow,
  approveLoan,
  repay,
  computeInterest,
} from "../src/services/federation/index.js";

async function setup(fund = 10_000_000) {
  const fed = await createFederation("Fed", `FED-${randomUUID()}`, "NGN");
  const coop = await prisma.cooperative.create({
    data: { name: "Coop", code: `C-${randomUUID()}`, currency: "NGN", federationFundBalance: fund },
  });
  await addMember(fed.id, coop.id);
  return { fed, coop };
}

async function activeLoan(fedId: string, coopId: string, amount: number, months: number) {
  const loan = await borrow(fedId, coopId, amount, months);
  await approveLoan(loan.id);
  return loan;
}

describe("federation loan repayment", () => {
  it("a partial repayment stays active, accumulates repaidKobo, and records one repayment row", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await activeLoan(fed.id, coop.id, 500_000, 3);
    await repay(loan.id, 200_000, coop.id);
    const after = await prisma.federationLoan.findUnique({ where: { id: loan.id } });
    expect(after?.status).toBe("active");
    expect(after?.repaidKobo).toBe(200_000);
    const repayments = await prisma.federationLoanRepayment.findMany({
      where: { loanId: loan.id },
    });
    expect(repayments).toHaveLength(1);
    expect(repayments[0]?.amountKobo).toBe(200_000);
    const interest = await prisma.federationPosting.findFirst({
      where: { account: "pool:liquidity", entry: { federationId: fed.id } },
    });
    expect(interest).toBeNull();
  });

  it("a full repayment marks the loan repaid", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await activeLoan(fed.id, coop.id, 500_000, 3);
    await repay(loan.id, 500_000, coop.id);
    const after = await prisma.federationLoan.findUnique({ where: { id: loan.id } });
    expect(after?.status).toBe("repaid");
    expect(after?.repaidKobo).toBe(500_000);
    const repayments = await prisma.federationLoanRepayment.findMany({
      where: { loanId: loan.id },
    });
    expect(repayments).toHaveLength(1);
  });

  it("charges simple interest once, on the final repayment", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await activeLoan(fed.id, coop.id, 500_000, 3);
    // Disbursed the full term ago → full-term interest.
    await prisma.federationLoan.update({
      where: { id: loan.id },
      data: { disbursedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
    });
    await repay(loan.id, 200_000, coop.id);
    await repay(loan.id, 300_000, coop.id);
    const expected = computeInterest(500_000, 0.12, 3);
    expect(expected).toBe(15_000);
    const interest = await prisma.federationPosting.findFirst({
      where: { account: "pool:liquidity", direction: "CREDIT", entry: { federationId: fed.id } },
    });
    expect(interest?.amount).toBe(expected);
    const coopInterest = await prisma.posting.findFirst({
      where: {
        account: "coop:federation_fund",
        direction: "CREDIT",
        entry: { cooperativeId: coop.id, description: "Federation loan interest" },
      },
    });
    expect(coopInterest?.amount).toBe(expected);
  });

  it("prorates interest over the actual outstanding period (early repayment costs less)", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await activeLoan(fed.id, coop.id, 500_000, 3);
    // Only 1 month outstanding → a third of the full-term interest.
    await prisma.federationLoan.update({
      where: { id: loan.id },
      data: { disbursedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });
    await repay(loan.id, 500_000, coop.id);
    const expected = computeInterest(500_000, 0.12, 3, 1);
    expect(expected).toBe(5_000);
    const interest = await prisma.federationPosting.findFirst({
      where: { account: "pool:liquidity", direction: "CREDIT", entry: { federationId: fed.id } },
    });
    expect(interest?.amount).toBe(expected);
  });

  it("caps interest at the full term for a late repayment", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await activeLoan(fed.id, coop.id, 500_000, 3);
    await prisma.federationLoan.update({
      where: { id: loan.id },
      data: { disbursedAt: new Date(Date.now() - 720 * 24 * 60 * 60 * 1000) }, // 24 months
    });
    await repay(loan.id, 500_000, coop.id);
    const interest = await prisma.federationPosting.findFirst({
      where: { account: "pool:liquidity", direction: "CREDIT", entry: { federationId: fed.id } },
    });
    expect(interest?.amount).toBe(15_000);
  });

  it("never rolls back a full repayment when the fund cannot cover the interest", async () => {
    const fed = await createFederation("Fed", `FED-${randomUUID()}`, "NGN");
    const lender = await prisma.cooperative.create({
      data: {
        name: "Lender",
        code: `L-${randomUUID()}`,
        currency: "NGN",
        federationFundBalance: 10_000_000,
      },
    });
    await addMember(fed.id, lender.id);
    await contribute(fed.id, lender.id, 1_000_000);

    // Borrower starts with no float: after the disbursement it holds exactly the
    // principal, so there is nothing left for the interest once it repays.
    const borrower = await prisma.cooperative.create({
      data: {
        name: "Borrower",
        code: `B-${randomUUID()}`,
        currency: "NGN",
        federationFundBalance: 0,
      },
    });
    await addMember(fed.id, borrower.id);
    const loan = await borrow(fed.id, borrower.id, 500_000, 3);
    await approveLoan(loan.id);
    await prisma.federationLoan.update({
      where: { id: loan.id },
      data: { disbursedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) },
    });

    // Must NOT throw — the principal repayment stands.
    await repay(loan.id, 500_000, borrower.id);

    const after = await prisma.federationLoan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(after.status).toBe("repaid");
    expect(
      (await prisma.cooperative.findUniqueOrThrow({ where: { id: borrower.id } }))
        .federationFundBalance,
    ).toBe(0);
    const shortfall = await prisma.auditLog.findFirst({
      where: { cooperativeId: borrower.id, action: "federation.interest.shortfall" },
    });
    expect(shortfall?.amount).toBe(15_000);
  });

  it("rejects a non-positive repayment before touching the fund or the loan", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await activeLoan(fed.id, coop.id, 500_000, 3);
    const before = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    await expect(repay(loan.id, -1, coop.id)).rejects.toThrow("INVALID_AMOUNT");
    const after = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(after?.federationFundBalance).toBe(before?.federationFundBalance);
    const loanAfter = await prisma.federationLoan.findUnique({ where: { id: loan.id } });
    expect(loanAfter?.status).toBe("active");
    expect(loanAfter?.repaidKobo).toBe(0);
  });

  it("rejects a non-positive borrow", async () => {
    const { fed, coop } = await setup();
    await expect(borrow(fed.id, coop.id, 0, 3)).rejects.toThrow("INVALID_AMOUNT");
  });

  it("rejects a repayment of another coop's loan and leaves the victim's fund unchanged", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await activeLoan(fed.id, coop.id, 500_000, 3);
    const attacker = await prisma.cooperative.create({
      data: {
        name: "Attacker",
        code: `A-${randomUUID()}`,
        currency: "NGN",
        federationFundBalance: 5_000_000,
      },
    });
    await addMember(fed.id, attacker.id);
    const victimBefore = await prisma.cooperative.findUniqueOrThrow({ where: { id: coop.id } });
    const attackerBefore = await prisma.cooperative.findUniqueOrThrow({
      where: { id: attacker.id },
    });

    await expect(repay(loan.id, 100_000, attacker.id)).rejects.toThrow("NOT_YOUR_LOAN");

    const victimAfter = await prisma.cooperative.findUniqueOrThrow({ where: { id: coop.id } });
    const attackerAfter = await prisma.cooperative.findUniqueOrThrow({
      where: { id: attacker.id },
    });
    expect(victimAfter.federationFundBalance).toBe(victimBefore.federationFundBalance);
    expect(attackerAfter.federationFundBalance).toBe(attackerBefore.federationFundBalance);
    const loanAfter = await prisma.federationLoan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(loanAfter.status).toBe("active");
    expect(loanAfter.repaidKobo).toBe(0);
  });

  it("rejects a repayment of an already-repaid loan (no double debit)", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await activeLoan(fed.id, coop.id, 500_000, 3);
    await repay(loan.id, 500_000, coop.id);
    const repaid = await prisma.cooperative.findUniqueOrThrow({ where: { id: coop.id } });

    await expect(repay(loan.id, 500_000, coop.id)).rejects.toThrow("LOAN_NOT_REPAYABLE");

    const after = await prisma.cooperative.findUniqueOrThrow({ where: { id: coop.id } });
    expect(after.federationFundBalance).toBe(repaid.federationFundBalance);
    const loanAfter = await prisma.federationLoan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(loanAfter.status).toBe("repaid");
    expect(loanAfter.repaidKobo).toBe(500_000);
  });
});
