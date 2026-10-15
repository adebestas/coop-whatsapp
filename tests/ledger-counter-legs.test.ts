import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { recordLedger } from "../src/services/ledger.js";
import { getBankAccountBalance } from "../src/services/journal.js";

/**
 * `recordLedger`'s counter-leg must be the account the money actually moved
 * to/from. Booking every income as cash-in at `assets:bank` overstated the
 * bank (and understated the loan portfolio / member wallet), which then fed
 * `getBankAccountBalance` — the precondition for dividend runs and liquidity.
 */
describe("ledger counter-legs", () => {
  it("books a wallet-funded income against the wallet, not the bank", async () => {
    const coop = await prisma.cooperative.create({
      data: { name: "C", code: `C${Date.now()}`, currency: "NGN" },
    });
    await recordLedger({
      cooperativeId: coop.id,
      type: "income",
      category: "interest",
      amount: 5_000,
      counterAccount: "member_wallet:w1",
    });

    expect(await getBankAccountBalance(coop.id)).toBe(0);
    const postings = await prisma.posting.findMany({
      where: { entry: { cooperativeId: coop.id } },
    });
    expect(
      postings.some((p) => p.account === "member_wallet:w1" && p.direction === "DEBIT"),
    ).toBe(true);
    expect(postings.some((p) => p.account === "assets:bank")).toBe(false);
  });

  it("books a bank income against the bank by default", async () => {
    const coop = await prisma.cooperative.create({
      data: { name: "C", code: `C${Date.now()}`, currency: "NGN" },
    });
    await recordLedger({ cooperativeId: coop.id, type: "income", category: "other", amount: 5_000 });
    expect(await getBankAccountBalance(coop.id)).toBe(5_000);
  });
});
