// tests/platform-policy.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma } from "./setup.js";
import {
  setPlatformPolicy,
  getEffectiveConfig,
  clearPlatformPolicyCache,
} from "../src/services/platform-policy.js";
import { updateCoopConfig } from "../src/services/coop-config.js";

let coopId: string;
beforeEach(async () => {
  clearPlatformPolicyCache();
  const c = await prisma.cooperative.create({ data: { name: "P", code: `PC${Date.now()}` } });
  coopId = c.id;
});

describe("platform policy resolution", () => {
  it("uses the platform default when the coop has no override", async () => {
    await setPlatformPolicy("loanInterestRate", { value: 7 });
    const { config } = await getEffectiveConfig(coopId);
    expect(config.loanInterestRate).toBe(7);
  });
  it("clamps a coop override to the platform bounds", async () => {
    await setPlatformPolicy("loanInterestRate", { min: 1, max: 20 });
    await updateCoopConfig(coopId, { loanInterestRate: 99 });
    clearPlatformPolicyCache();
    const { config } = await getEffectiveConfig(coopId);
    expect(config.loanInterestRate).toBe(20);
  });
  it("ignores a coop override when the rule is locked", async () => {
    await setPlatformPolicy("loanInterestRate", { value: 5, locked: true });
    await updateCoopConfig(coopId, { loanInterestRate: 30 });
    clearPlatformPolicyCache();
    const { config } = await getEffectiveConfig(coopId);
    expect(config.loanInterestRate).toBe(5);
  });
  it("rejects an unknown rule key", async () => {
    await expect(setPlatformPolicy("bogus", { value: 1 })).rejects.toThrow();
  });
});

describe("platform policy bounds", () => {
  afterEach(async () => {
    await prisma.platformPolicy.deleteMany({
      where: { key: { in: ["reserveFundPercent", "dividendCapPercent"] } },
    });
    clearPlatformPolicyCache();
  });

  it("rejects a minimum below the statutory floor", async () => {
    await expect(setPlatformPolicy("reserveFundPercent", { min: 10 })).rejects.toThrow(
      /statutory minimum/,
    );
  });

  it("rejects a value below the statutory floor", async () => {
    await expect(setPlatformPolicy("reserveFundPercent", { value: 10 })).rejects.toThrow(
      /at least 25/,
    );
  });

  it("rejects a maximum above the statutory ceiling", async () => {
    await expect(setPlatformPolicy("dividendCapPercent", { max: 50 })).rejects.toThrow(
      /statutory maximum/,
    );
  });

  it("rejects a non-numeric value for a numeric rule", async () => {
    await expect(
      setPlatformPolicy("reserveFundPercent", { value: "30" as unknown as number }),
    ).rejects.toThrow(/finite number/);
  });

  it("applies an in-bounds override", async () => {
    await setPlatformPolicy("reserveFundPercent", { value: 30, locked: true });
    const { config } = await getEffectiveConfig(coopId);
    expect(config.reserveFundPercent).toBe(30);
  });
});

describe("platform policy provenance", () => {
  it("reports platform source when the coop has no stored value", async () => {
    await setPlatformPolicy("loanInterestRate", { value: 7, locked: false });
    const { config, meta } = await getEffectiveConfig(coopId);
    expect(meta.loanInterestRate.source).toBe("platform");
    expect(config.loanInterestRate).toBe(7);
  });

  it("reports coop source once the coop stores its own value", async () => {
    await setPlatformPolicy("loanInterestRate", { value: 7, locked: false });
    await updateCoopConfig(coopId, { loanInterestRate: 9 });
    const { config, meta } = await getEffectiveConfig(coopId);
    expect(meta.loanInterestRate.source).toBe("coop");
    expect(config.loanInterestRate).toBe(9);
  });

  it("reports platform source for a locked rule even when the coop stored a value", async () => {
    await setPlatformPolicy("loanInterestRate", { value: 7, locked: true });
    await updateCoopConfig(coopId, { loanInterestRate: 9 });
    const { config, meta } = await getEffectiveConfig(coopId);
    expect(meta.loanInterestRate.source).toBe("platform");
    expect(config.loanInterestRate).toBe(7);
  });
});
