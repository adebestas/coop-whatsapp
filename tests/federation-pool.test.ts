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
  getPosition,
  getPoolBalance,
  fundFederation,
} from "../src/services/federation/index.js";

async function setup(fund = 10_000_000, reserve = 5_000_000) {
  const fed = await createFederation("Fed", `FED-${randomUUID()}`, "NGN");
  const coop = await prisma.cooperative.create({
    data: {
      name: "Coop",
      code: `C-${randomUUID()}`,
      currency: "NGN",
      federationFundBalance: fund,
      reserveFundBalance: reserve,
    },
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
    expect(await getPoolBalance(fed.id)).toBe(1_000_000);
  });

  it("funds the federation fund from the coop reserve", async () => {
    const { coop } = await setup();
    await fundFederation(coop.id, 500_000);
    const after = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(after?.reserveFundBalance).toBe(4_500_000);
    expect(after?.federationFundBalance).toBe(10_500_000);
    const posting = await prisma.posting.findFirst({
      where: {
        account: "coop:federation_fund",
        direction: "DEBIT",
        entry: { cooperativeId: coop.id },
      },
    });
    expect(posting?.amount).toBe(500_000);
  });

  it("rejects funding beyond the reserve", async () => {
    const { coop } = await setup(10_000_000, 1_000_000);
    await expect(fundFederation(coop.id, 2_000_000)).rejects.toThrow("INSUFFICIENT_RESERVE");
    const after = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(after?.reserveFundBalance).toBe(1_000_000);
  });

  it("borrows from the pool and repays", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const loan = await borrow(fed.id, coop.id, 500_000, 3);
    expect(loan.status).toBe("pending");
    await approveLoan(loan.id);
    const active = await prisma.federationLoan.findUnique({ where: { id: loan.id } });
    expect(active?.status).toBe("active");
    await repay(loan.id, 500_000, coop.id);
    const after = await prisma.federationLoan.findUnique({ where: { id: loan.id } });
    expect(after?.status).toBe("repaid");
  });

  it("rejects a borrow that exceeds the pool liquidity", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    await expect(borrow(fed.id, coop.id, 2_000_000, 3)).rejects.toThrow(
      "INSUFFICIENT_POOL_LIQUIDITY",
    );
  });

  it("creates a pending loan and only moves money on approval (idempotent)", async () => {
    const { fed, coop } = await setup();
    await contribute(fed.id, coop.id, 1_000_000);
    const before = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    const loan = await borrow(fed.id, coop.id, 500_000, 3);
    expect(loan.status).toBe("pending");
    expect(loan.disbursedAt).toBeNull();
    const mid = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(mid?.federationFundBalance).toBe(before?.federationFundBalance);

    await approveLoan(loan.id);
    const after = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(after?.federationFundBalance).toBe((before?.federationFundBalance ?? 0) + 500_000);

    await approveLoan(loan.id);
    const again = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(again?.federationFundBalance).toBe(after?.federationFundBalance);
  });

  it("rejects a non-positive contribution and leaves the fund unchanged", async () => {
    const { fed, coop } = await setup();
    await expect(contribute(fed.id, coop.id, -1)).rejects.toThrow("INVALID_AMOUNT");
    const after = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(after?.federationFundBalance).toBe(10_000_000);
  });
});
