import { describe, it, expect } from "vitest";
import "./setup.js";
import { coopStats, platformOverview, coopActivity } from "../src/services/platform-monitoring.js";
import { provisionCooperative } from "../src/services/cooperative-provisioning.js";
import { withCoopContext } from "../src/lib/tenant-context.js";
import { audit } from "../src/services/audit.js";

let seq = 0;
const unique = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

function makeCoop(name: string) {
  return provisionCooperative({
    name,
    code: `M${unique()}`,
    adminPhone: `2348${(1000000000 + seq * 7).toString().slice(0, 9)}`,
  });
}

describe("platform monitoring", () => {
  it("counts members and loan book per coop, isolated by tenant", async () => {
    const a = await makeCoop("A");
    const b = await makeCoop("B");
    const stats = await coopStats(a.cooperativeId);
    expect(stats.memberCount).toBe(1);
    const statsB = await coopStats(b.cooperativeId);
    expect(statsB.memberCount).toBe(1); // does not include A's member
  });

  it("raises a delinquency alert when >10% of the loan book is overdue", async () => {
    const { cooperativeId, adminMemberId } = await makeCoop("Delinquent");
    await withCoopContext(cooperativeId, (tx) =>
      tx.loan.create({
        data: {
          amount: 100_000,
          balance: 100_000,
          status: "disbursed",
          dueDate: new Date(Date.now() - 86_400_000),
          memberId: adminMemberId,
          cooperativeId,
        },
      }),
    );

    const stats = await coopStats(cooperativeId);
    expect(stats.loanCount).toBe(1);
    expect(stats.overdueCount).toBe(1);
    expect(stats.overdueAmount).toBe(100_000);
    expect(stats.delinquencyPct).toBeGreaterThan(10);

    const overview = await platformOverview();
    const alert = overview.alerts.find(
      (a) => a.type === "delinquency" && a.cooperativeId === cooperativeId,
    );
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("warning");
  });

  it("raises a failed-payout alert for a failed payout", async () => {
    const { cooperativeId, adminMemberId } = await makeCoop("FailedPay");
    await withCoopContext(cooperativeId, (tx) =>
      tx.payout.create({
        data: {
          amount: 50_000,
          reference: `REF-${unique()}`,
          status: "failed",
          memberId: adminMemberId,
          cooperativeId,
        },
      }),
    );

    const stats = await coopStats(cooperativeId);
    expect(stats.failedPayouts).toBe(1);

    const overview = await platformOverview();
    const alert = overview.alerts.find(
      (a) => a.type === "failed_payouts" && a.cooperativeId === cooperativeId,
    );
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("critical");
  });

  it("raises an AML alert for a pending suspicious transaction report", async () => {
    const { cooperativeId, adminMemberId } = await makeCoop("Aml");
    await withCoopContext(cooperativeId, (tx) =>
      tx.sTR.create({
        data: {
          cooperativeId,
          memberId: adminMemberId,
          amount: 900_000,
          reason: "structuring below reporting threshold",
          status: "pending",
        },
      }),
    );

    const stats = await coopStats(cooperativeId);
    expect(stats.pendingAmlCount).toBe(1);

    const overview = await platformOverview();
    const alert = overview.alerts.find(
      (a) => a.type === "aml_review" && a.cooperativeId === cooperativeId,
    );
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("warning");
  });

  it("sums platform totals across cooperatives", async () => {
    await makeCoop("TotalsA");
    await makeCoop("TotalsB");

    const overview = await platformOverview();
    expect(overview.coops.length).toBeGreaterThanOrEqual(2);
    expect(overview.totals.coopCount).toBe(overview.coops.length);
    expect(overview.totals.memberCount).toBe(
      overview.coops.reduce((n, c) => n + c.memberCount, 0),
    );
    expect(overview.totals.loanOutstanding).toBe(
      overview.coops.reduce((n, c) => n + c.loanOutstanding, 0),
    );
    expect(overview.totals.walletFloat).toBe(
      overview.coops.reduce((n, c) => n + c.walletFloat, 0),
    );
  });

  it("returns the coop's recent audit entries as activity", async () => {
    const { cooperativeId } = await makeCoop("Activity");
    await audit({
      cooperativeId,
      actorPhone: "2348000000000",
      action: "monitoring.test.marker",
      detail: "seeded for coopActivity",
    });

    const entries = await coopActivity(cooperativeId);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.some((e) => e.action === "monitoring.test.marker")).toBe(true);
  });
});
