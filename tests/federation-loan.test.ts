import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma.js";
import {
  createFederation,
  addMember,
  contribute,
  borrow,
  approveLoan,
  markDefaulted,
} from "../src/services/federation/index.js";

async function setup() {
  const fed = await createFederation("Fed", `FED-${randomUUID()}`, "NGN");
  const lender = await prisma.cooperative.create({
    data: {
      name: "Lender",
      code: `L-${randomUUID()}`,
      currency: "NGN",
      federationFundBalance: 10_000_000,
    },
  });
  const borrower = await prisma.cooperative.create({
    data: { name: "Borrower", code: `B-${randomUUID()}`, currency: "NGN" },
  });
  await addMember(fed.id, lender.id);
  await addMember(fed.id, borrower.id);
  return { fed, lender, borrower };
}

describe("bilateral federation loan", () => {
  it("records the lender and can be marked defaulted", async () => {
    const { fed, lender, borrower } = await setup();
    await contribute(fed.id, lender.id, 1_000_000);
    const loan = await borrow(fed.id, borrower.id, 500_000, 3, lender.id);
    expect(loan.lenderCooperativeId).toBe(lender.id);
    expect(loan.status).toBe("pending");
    await approveLoan(loan.id);
    await markDefaulted(loan.id);
    const after = await prisma.federationLoan.findUnique({ where: { id: loan.id } });
    expect(after?.status).toBe("defaulted");
  });

  it("earmarks the lender's stake at request time", async () => {
    const { fed, lender, borrower } = await setup();
    await contribute(fed.id, lender.id, 1_000_000);
    await borrow(fed.id, borrower.id, 500_000, 3, lender.id);
    const earmark = await prisma.posting.findFirst({
      where: {
        account: "federation:loan_receivable",
        direction: "DEBIT",
        entry: { cooperativeId: lender.id },
      },
    });
    expect(earmark?.amount).toBe(500_000);
  });

  it("rejects a bilateral loan when the lender's stake is too small", async () => {
    const { fed, lender, borrower } = await setup();
    const funder = await prisma.cooperative.create({
      data: {
        name: "Funder",
        code: `F-${randomUUID()}`,
        currency: "NGN",
        federationFundBalance: 10_000_000,
      },
    });
    await addMember(fed.id, funder.id);
    await contribute(fed.id, lender.id, 1_000_000);
    await contribute(fed.id, funder.id, 1_000_000);
    await expect(borrow(fed.id, borrower.id, 1_500_000, 3, lender.id)).rejects.toThrow(
      "INSUFFICIENT_LENDER_STAKE",
    );
  });
});
