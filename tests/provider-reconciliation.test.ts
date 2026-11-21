import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, cleanupDatabase } from "./setup.js";
import { reconcileProviderBalances } from "../src/services/reconcile.js";

const POSTING = {
  account: "assets:bank",
  direction: "DEBIT",
  amount: 5_000_000,
};

async function postBank(coopId: string, txRef: string, amount = POSTING.amount) {
  const entry = await prisma.journalEntry.create({
    data: { cooperativeId: coopId, txRef, description: "test deposit" },
  });
  await prisma.posting.create({
    data: { entryId: entry.id, account: "assets:bank", direction: "DEBIT", amount },
  });
}

beforeEach(async () => {
  await cleanupDatabase();
  process.env.PAYSTACK_SECRET_KEY = "sk_test_dummy";
  delete process.env.FLUTTERWAVE_SECRET_KEY;
  delete process.env.MONNIFY_API_KEY;
  delete process.env.MONNIFY_SECRET_KEY;
  delete process.env.MONNIFY_CONTRACT_CODE;
  delete process.env.RECONCILE_DRIFT_THRESHOLD_KOBO;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PAYSTACK_SECRET_KEY;
});

describe("provider balance reconciliation", () => {
  it("logs an ok snapshot when providers match the journal", async () => {
    const coop = await createTestCoop("PROV1");
    await postBank(coop.id, "prov-1", 4_000_000);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ currency: "NGN", balance: 4_000_000 }] }),
      })) as unknown as typeof fetch,
    );

    const alerts = await reconcileProviderBalances();
    expect(alerts).toEqual([]);

    const log = await prisma.reconciliationLog.findFirst({ where: { source: "provider" } });
    expect(log?.status).toBe("ok");
    expect(log?.discrepancy).toBe(0);
    expect(log?.totalWalletBalances).toBe(4_000_000);
    expect(log?.bankBalance).toBe(4_000_000);
  });

  it("alerts developers when drift crosses the threshold", async () => {
    const coop = await createTestCoop("PROV2");
    await postBank(coop.id, "prov-2", 1_000_000);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ currency: "NGN", balance: 1_500_000 }] }),
      })) as unknown as typeof fetch,
    );

    const alerts = await reconcileProviderBalances();
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain("drift");

    const log = await prisma.reconciliationLog.findFirst({ where: { source: "provider" } });
    expect(log?.status).toBe("discrepancy");
    expect(log?.discrepancy).toBe(500_000);
  });

  it("is a no-op when no provider key is configured", async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    const coop = await createTestCoop("PROV3");
    await postBank(coop.id, "prov-3");

    const alerts = await reconcileProviderBalances();
    expect(alerts).toEqual([]);
    expect(await prisma.reconciliationLog.count()).toBe(0);
  });
});
