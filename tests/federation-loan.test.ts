import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { createFederation, addMember, contribute, borrow, markDefaulted } from "../src/services/federation/index.js";

async function setup() {
  const fed = await createFederation("Fed", `FED${Date.now()}`, "NGN");
  const lender = await prisma.cooperative.create({ data: { name: "Lender", code: `L${Date.now()}`, currency: "NGN", federationFundBalance: 10_000_000 } });
  const borrower = await prisma.cooperative.create({ data: { name: "Borrower", code: `B${Date.now()}`, currency: "NGN" } });
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
    await markDefaulted(loan.id);
    const after = await prisma.federationLoan.findUnique({ where: { id: loan.id } });
    expect(after?.status).toBe("defaulted");
  });
});
