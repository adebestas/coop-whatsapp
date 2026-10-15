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
    await repay(loan.id, 200_000);
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
    await repay(loan.id, 500_000);
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
    await repay(loan.id, 200_000);
    await repay(loan.id, 300_000);
    const expected = computeInterest(500_000, 0.12, 3);
    expect(expected).toBe(15_000);
    const interest = await prisma.federationPosting.findFirst({
      where: { account: "pool:liquidity", direction: "CREDIT", entry: { federationId: fed.id } },
    });
    expect(interest?.amount).toBe(expected);
    const coopInterest = await prisma.posting.findFirst({
      where: { account: "federation:fund", direction: "CREDIT", entry: { cooperativeId: coop.id } },
    });
    expect(coopInterest?.amount).toBe(expected);
  });

  it("rejects a non-positive repayment before touching the fund or the loan", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await activeLoan(fed.id, coop.id, 500_000, 3);
    const before = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    await expect(repay(loan.id, -1)).rejects.toThrow("INVALID_AMOUNT");
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
});
