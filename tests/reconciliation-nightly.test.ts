import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { runWalletReconciliation } from "../src/services/reconciliation.js";
import { runReconciliation } from "../src/services/reconcile.js";
import { runReconcileJob } from "../src/services/scheduler.js";
import { postJournal } from "../src/services/journal.js";
import { notifyMember } from "../src/lib/messaging.js";

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanupDatabase();
});

describe("nightly reconciliation & wallet-bank financial integrity", () => {
  it("reports ok with zero discrepancy when wallets and bank postings match", async () => {
    const coop = await createTestCoop("RECOK1");
    const admin = await createTestMember(coop.id, { phone: "2348011111111", role: "superadmin" });
    const member = await createTestMember(coop.id, { phone: "2348022222222" });

    // Deposit 50,000 NGN (5,000,000 kobo) into member wallet with a matching journal entry to assets:bank
    await prisma.wallet.update({
      where: { memberId: member.id },
      data: { balance: 5000000 },
    });

    // Journal: Debit assets:bank (5,000,000 kobo), Credit liabilities:savings
    await postJournal({
      cooperativeId: coop.id,
      txRef: "test_dep_01",
      description: "Member deposit",
      postings: [
        { account: "assets:bank", direction: "DEBIT", amount: 5000000 },
        {
          account: "liabilities:savings",
          direction: "CREDIT",
          amount: 5000000,
          memberId: member.id,
        },
      ],
    });

    const result = await runWalletReconciliation(coop.id, admin.phone);
    expect(result.ok).toBe(true);
    expect(result.discrepancy).toBe(0);
    expect(result.status).toBe("ok");
    expect(result.message).toContain("Discrepancy:         ₦0.00 ✅");

    const log = await prisma.reconciliationLog.findUnique({ where: { id: result.logId } });
    expect(log).not.toBeNull();
    expect(log?.totalWalletBalances).toBe(5000000);
    expect(log?.bankBalance).toBe(5000000);
    expect(log?.discrepancy).toBe(0);
  });

  it("detects discrepancy and logs to ReconciliationLog when wallet balances do not match assets:bank", async () => {
    const coop = await createTestCoop("RECGAP1");
    const admin = await createTestMember(coop.id, { phone: "2348033333333", role: "superadmin" });
    const member = await createTestMember(coop.id, { phone: "2348044444444" });

    // Wallet has 100,000 NGN, but no bank posting was ever made
    await prisma.wallet.update({
      where: { memberId: member.id },
      data: { balance: 10000000 },
    });

    const result = await runWalletReconciliation(coop.id, admin.phone);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("discrepancy");
    expect(result.discrepancy).toBe(-10000000);
    expect(result.message).toContain("DISCREPANCY DETECTED!");
    expect(result.message).toContain("Gap:                 ₦100,000.00");

    const log = await prisma.reconciliationLog.findUnique({ where: { id: result.logId } });
    expect(log?.discrepancy).toBe(-10000000);
  });

  it("runReconciliation includes wallet-bank discrepancy check in nightly alerts", async () => {
    const coop = await createTestCoop("RECALERT1");
    const superadmin = await createTestMember(coop.id, {
      phone: "2348055555555",
      role: "superadmin",
    });
    const member = await createTestMember(coop.id, { phone: "2348066666666" });

    // Inject an unbacked wallet balance
    await prisma.wallet.update({
      where: { memberId: member.id },
      data: { balance: 2500000 }, // 25,000 NGN
    });

    const alerts = await runReconciliation();
    expect(
      alerts.some((a) => a.includes("Balance discrepancy detected") && a.includes("₦25,000.00")),
    ).toBe(true);

    // Verify notification was sent to superadmin
    const notifyCalls = vi.mocked(notifyMember).mock.calls;
    const alertSentToAdmin = notifyCalls.some(
      (c) =>
        String((c[0] as any).phone ?? c[0]) === superadmin.phone &&
        String(c[1]).includes("Balance discrepancy detected"),
    );
    expect(alertSentToAdmin).toBe(true);
  });

  it("runReconcileJob executes cleanly through the scheduler money path wrapper", async () => {
    await expect(runReconcileJob()).resolves.not.toThrow();
  });
});
