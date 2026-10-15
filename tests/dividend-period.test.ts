import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { recordLedger } from "../src/services/ledger.js";
import { previewDividendRun } from "../src/services/dividends.js";

async function setup() {
  const coop = await prisma.cooperative.create({
    data: { name: "C", code: `C${Date.now()}`, currency: "NGN" },
  });
  const admin = await prisma.member.create({
    data: {
      code: `A${Date.now()}`,
      phone: `+234${Date.now()}`,
      name: "Admin",
      cooperativeId: coop.id,
      role: "superadmin",
      wallet: { create: {} },
    },
  });
  await prisma.member.create({
    data: {
      code: `M${Date.now()}`,
      phone: `+2341${Date.now()}`,
      name: "Member",
      cooperativeId: coop.id,
      wallet: { create: { totalSaved: 1_000_000, balance: 1_000_000 } },
    },
  });
  return { coop, admin };
}

/**
 * The dividend base is THIS period's profit. Using all-time P&L let a new
 * period re-declare the same profit (a distribution out of capital).
 */
describe("dividend base is period-scoped", () => {
  it("ignores prior-period profit", async () => {
    const { coop, admin } = await setup();
    const lastYear = new Date(new Date().getFullYear() - 1, 5, 1);
    await prisma.ledgerEntry.create({
      data: {
        cooperativeId: coop.id,
        type: "income",
        category: "interest",
        amount: 100_000,
        createdAt: lastYear,
      },
    });
    const preview = await previewDividendRun(admin.phone, 5);
    expect(preview.ok).toBe(false);
  });

  it("distributes this period's profit", async () => {
    const { coop, admin } = await setup();
    await recordLedger({
      cooperativeId: coop.id,
      type: "income",
      category: "interest",
      amount: 100_000,
    });
    const preview = await previewDividendRun(admin.phone, 5);
    expect(preview.ok).toBe(true);
  });
});
