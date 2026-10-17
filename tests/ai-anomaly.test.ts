import { describe, expect, it } from "vitest";
import { prisma, createTestCoop, createTestMember } from "./setup.js";
import { detectAnomalies, formatAnomalies } from "../src/lib/ai-anomaly.js";

describe("anomaly detection (advisory)", () => {
  it("flags a payout far above the cooperative's median", async () => {
    const coop = await createTestCoop("ANOM1");
    const member = await createTestMember(coop.id, { phone: "2348090000400" });

    for (let i = 0; i < 5; i++) {
      await prisma.payout.create({
        data: {
          amount: 10000,
          reference: `BASE-${i}`,
          idempotencyKey: `BASE-${i}`,
          status: "successful",
          memberId: member.id,
          cooperativeId: coop.id,
        },
      });
    }
    await prisma.payout.create({
      data: {
        amount: 1_000_000,
        reference: "BIG",
        idempotencyKey: "BIG",
        status: "successful",
        memberId: member.id,
        cooperativeId: coop.id,
      },
    });

    const anomalies = await detectAnomalies(coop.id);
    const large = anomalies.find((a) => a.kind === "large_payout");
    expect(large).toBeTruthy();
    expect(large!.severity).toBe("high");
  });

  it("returns nothing for a quiet cooperative", async () => {
    const coop = await createTestCoop("ANOM2");
    const anomalies = await detectAnomalies(coop.id);
    expect(anomalies).toEqual([]);
    expect(formatAnomalies(anomalies)).toContain("No anomalies");
  });
});
