import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { createFederation, addMember, contribute, borrow, repay, getPosition } from "../src/services/federation/index.js";

async function setup(fund = 10_000_000) {
  const fed = await createFederation("Fed", `FED${Date.now()}`, "NGN");
  const coop = await prisma.cooperative.create({
    data: { name: "Coop", code: `C${Date.now()}`, currency: "NGN", federationFundBalance: fund },
  });
  await addMember(fed.id, coop.id);
  return { fed, coop };
}

describe("federation pool", () => {
  it("contributes from the coop fund into the pool", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const updated = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(updated?.federationFundBalance).toBe(9_000_000);
    const pos = await getPosition(fed.id, coop.id);
    expect(pos.stakeKobo).toBe(1_000_000);
  });

  it("borrows from the pool and repays", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await borrow(fed.id, coop.id, 500_000, 3);
    expect(loan.status).toBe("active");
    await repay(loan.id, 500_000);
    const after = await prisma.federationLoan.findUnique({ where: { id: loan.id } });
    expect(after?.status).toBe("repaid");
  });
});
