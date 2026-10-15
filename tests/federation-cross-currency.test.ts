import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/lib/prisma.js";
import {
  createFederation,
  addMember,
  fundFederation,
  contribute,
  borrow,
  approveLoan,
  repay,
  getPosition,
  getPoolBalance,
} from "../src/services/federation/index.js";
import { setRate } from "../src/services/federation/fx.js";

/**
 * Cross-currency path: a GHS cooperative in an NGN-base federation. Every move
 * is booked in the coop's currency on the coop journal / `federationFundBalance`
 * column and in the federation's BASE currency on the platform ledger, using the
 * FX rate captured at the time of the move.
 */
describe("federation cross-currency", () => {
  it("books the coop in GHS and the federation ledger in NGN through the full lifecycle", async () => {
    const fed = await createFederation("CrossFed", `FED-${randomUUID()}`, "NGN");
    const coop = await prisma.cooperative.create({
      data: {
        name: "Ghana Coop",
        code: `G-${randomUUID()}`,
        currency: "GHS",
        reserveFundBalance: 100_000_000,
        federationFundBalance: 0,
      },
    });
    await addMember(fed.id, coop.id);

    // 1 NGN = 0.01 GHS  =>  1 GHS = 100 NGN.
    await setRate(fed.id, "NGN", "GHS", 0.01, "test");

    // Commit own reserve capital (coop currency — no FX applies to funding).
    await fundFederation(coop.id, 10_000_000);

    // Contribute 5,000,000 GHS-minor → 500,000,000 NGN-minor into the pool.
    await contribute(fed.id, coop.id, 5_000_000);

    // Borrow 2,000,000 GHS-minor (200,000,000 NGN-minor) for 3 months.
    const loan = await borrow(fed.id, coop.id, 2_000_000, 3);
    expect(loan.currency).toBe("GHS");
    expect(loan.fxRateToBase).toBe(100);
    await approveLoan(loan.id);

    // Full principal repayment → simple interest 2,000,000 × 12% × 3/12 = 60,000.
    await repay(loan.id, 2_000_000, coop.id);

    const after = await prisma.cooperative.findUniqueOrThrow({ where: { id: coop.id } });
    // 10,000,000 funded − 5,000,000 contributed + 2,000,000 borrowed
    //   − 2,000,000 principal − 60,000 interest = 4,940,000 (GHS-minor).
    expect(after.federationFundBalance).toBe(4_940_000);

    // The coop's federation-fund ledger must net exactly to the denormalized
    // `federationFundBalance` column (one economic account, one account name).
    const fundPostings = await prisma.posting.findMany({
      where: { account: "coop:federation_fund", entry: { cooperativeId: coop.id } },
    });
    const fundNet = fundPostings.reduce(
      (sum, p) => sum + (p.direction === "DEBIT" ? p.amount : -p.amount),
      0,
    );
    expect(fundNet).toBe(after.federationFundBalance);

    // Federation pool (base NGN-minor): +500,000,000 contributed
    //   − 200,000,000 disbursed + 200,000,000 principal repaid + 6,000,000 interest.
    expect(await getPoolBalance(fed.id)).toBe(506_000_000);

    // The coop's pool stake / what it owes are held in the federation's base currency.
    const pos = await getPosition(fed.id, coop.id);
    expect(pos.stakeKobo).toBe(500_000_000);
    expect(pos.owedKobo).toBe(0);

    const loanAfter = await prisma.federationLoan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(loanAfter.status).toBe("repaid");
    expect(loanAfter.repaidKobo).toBe(2_000_000);
  });

  it("rejects a bilateral borrow when the lender's base-currency stake is too small", async () => {
    const fed = await createFederation("CrossFed2", `FED-${randomUUID()}`, "NGN");
    await setRate(fed.id, "NGN", "GHS", 0.01, "test");

    const lender = await prisma.cooperative.create({
      data: {
        name: "Lender GHS",
        code: `L-${randomUUID()}`,
        currency: "GHS",
        federationFundBalance: 2_000_000,
      },
    });
    const borrower = await prisma.cooperative.create({
      data: { name: "Borrower GHS", code: `B-${randomUUID()}`, currency: "GHS" },
    });
    // A third coop contributes enough to the pool that the liquidity guard
    // passes and the lender-stake guard is the one that must fire.
    const funder = await prisma.cooperative.create({
      data: {
        name: "Funder GHS",
        code: `F-${randomUUID()}`,
        currency: "GHS",
        federationFundBalance: 4_000_000,
      },
    });
    await addMember(fed.id, lender.id);
    await addMember(fed.id, borrower.id);
    await addMember(fed.id, funder.id);

    // Lender contributes 1,000,000 GHS-minor → 100,000,000 NGN-minor staked.
    await contribute(fed.id, lender.id, 1_000_000);
    // Funder contributes 3,000,000 GHS-minor → pool now 400,000,000 NGN-minor.
    await contribute(fed.id, funder.id, 3_000_000);

    // Borrower asks for 2,000,000 GHS-minor (200,000,000 NGN base) from that
    // lender, whose stake is only 100,000,000 in base — pool has the cash, but
    // the named lender does not have the base-currency stake. Must be rejected.
    await expect(borrow(fed.id, borrower.id, 2_000_000, 3, lender.id)).rejects.toThrow(
      "INSUFFICIENT_LENDER_STAKE",
    );
  });
});
