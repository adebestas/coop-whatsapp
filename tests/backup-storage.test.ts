/**
 * PERF-2: a local-only backup is worthless on an ephemeral host (Render wipes
 * the container on redeploy), so production must FAIL CLOSED unless
 * off-instance storage is configured or the operator explicitly opts in.
 */
import { describe, expect, it } from "vitest";
import { planBackupStorage } from "../src/services/backup.js";

describe("planBackupStorage", () => {
  it("uses S3 whenever it is configured (any environment)", () => {
    expect(planBackupStorage({ nodeEnv: "production", s3Configured: true }).mode).toBe("s3");
    expect(planBackupStorage({ nodeEnv: "development", s3Configured: true }).mode).toBe("s3");
  });

  it("allows local disk outside production", () => {
    expect(planBackupStorage({ nodeEnv: "development", s3Configured: false }).mode).toBe("local");
    expect(planBackupStorage({ nodeEnv: "test", s3Configured: false }).mode).toBe("local");
  });

  it("refuses local-only in production", () => {
    const plan = planBackupStorage({ nodeEnv: "production", s3Configured: false });
    expect(plan.mode).toBe("error");
    expect(plan.reason).toMatch(/off-instance/);
  });

  it("allows local-only in production only with the explicit opt-in", () => {
    expect(
      planBackupStorage({ nodeEnv: "production", s3Configured: false, allowLocal: true }).mode,
    ).toBe("local");
  });
});
