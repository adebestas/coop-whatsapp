import { describe, it, expect } from "vitest";
import { getRule } from "../src/lib/rule-registry.js";

describe("statutory rules", () => {
  it("reserve fund floor is 25% and locked by default", () => {
    const r = getRule("reserveFundPercent")!;
    expect(r).toBeDefined();
    expect(r.min).toBe(25);
    expect(r.default).toBe(25);
    expect(r.statutory).toBeTruthy();
  });
  it("education fund is capped at 10%", () => {
    const r = getRule("educationFundPercent")!;
    expect(r).toBeDefined();
    expect(r.max).toBe(10);
    expect(r.default).toBe(10);
    expect(r.statutory).toBeTruthy();
  });
  it("dividend cap is 5%", () => {
    const r = getRule("dividendCapPercent")!;
    expect(r).toBeDefined();
    expect(r.max).toBe(5);
    expect(r.default).toBe(5);
    expect(r.statutory).toBeTruthy();
  });
});
