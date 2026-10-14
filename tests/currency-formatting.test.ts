import { describe, it, expect } from "vitest";
import { formatBalance } from "../src/lib/money.js";
import { runWithCurrency } from "../src/lib/runtime-context.js";

describe("formatBalance", () => {
  it("defaults to NGN outside a context", () => {
    expect(formatBalance(100050)).toBe("₦1,000.50");
  });

  it("uses the runtime context currency", () => {
    runWithCurrency("GHS", () => {
      expect(formatBalance(100050)).toBe("₵1,000.50");
    });
  });

  it("lets an explicit currency override the context", () => {
    runWithCurrency("GHS", () => {
      expect(formatBalance(100050, "KES")).toBe("KSh1,000.50");
    });
  });
});
