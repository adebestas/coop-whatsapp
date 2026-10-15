import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma.js";
import { createFederation, addMember, contribute, borrow, repay } from "../src/services/federation/index.js";

async function setup(fund = 10_000_000) {
  const fed = await createFederation("Fed", `FED-${randomUUID()}`, "NGN");
  const coop = await prisma.cooperative.create({
    data: { name: "Coop", code: `C-${randomUUID()}`, currency: "NGN", federationFundBalance: fund },
  });
  await addMember(fed.id, coop.id);
  return { fed, coop };
}

describe("federation loan repayment", () => {
  it("a partial repayment stays active, accumulates repaidKobo, and records one repayment row", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await borrow(fed.id, coop.id, 500_000, 3);
    await repay(loan.id, 200_000);
    const after = await prisma.federationLoan.findUnique({ where: { id: loan.id } });
    expect(after?.status).toBe("active");
    expect(after?.repaidKobo).toBe(200_000);
    const repayments = await prisma.federationLoanRepayment.findMany({ where: { loanId: loan.id } });
    expect(repayments).toHaveLength(1);
    expect(repayments[0]?.amountKobo).toBe(200_000);
  });

  it("a full repayment marks the loan repaid", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await borrow(fed.id, coop.id, 500_000, 3);
    await repay(loan.id, 500_000);
    const after = await prisma.federationLoan.findUnique({ where: { id: loan.id } });
    expect(after?.status).toBe("repaid");
    expect(after?.repaidKobo).toBe(500_000);
    const repayments = await prisma.federationLoanRepayment.findMany({ where: { loanId: loan.id } });
    expect(repayments).toHaveLength(1);
  });

  it("rejects a non-positive repayment before touching the fund or the loan", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await borrow(fed.id, coop.id, 500_000, 3);
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
