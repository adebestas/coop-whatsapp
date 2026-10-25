// tests/rule-registry.test.ts
import { describe, it, expect } from "vitest";
import { RULE_REGISTRY, getRule, RULE_KEYS } from "../src/lib/rule-registry.js";

describe("rule registry", () => {
  it("contains the core loan rules", () => {
    for (const k of [
      "loanInterestRate",
      "loanDurationMonths",
      "maxLoanMultiplier",
      "minGuarantors",
    ]) {
      expect(RULE_KEYS).toContain(k);
    }
  });
  it("rejects out-of-range and unknown keys", () => {
    expect(getRule("nope")).toBeUndefined();
    expect(getRule("loanDurationMonths")!.min).toBe(1);
    expect(getRule("loanInterestRate")!.max).toBe(60);
    expect(getRule("loanDurationMonths")!.default).toBe(12);
  });
  it("every rule default is within its own bounds", () => {
    for (const [k, r] of Object.entries(RULE_REGISTRY)) {
      if (typeof r.default === "number") {
        expect(r.default, k).toBeGreaterThanOrEqual(r.min ?? -Infinity);
        expect(r.default, k).toBeLessThanOrEqual(r.max ?? Infinity);
      }
    }
  });
});
