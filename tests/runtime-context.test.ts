import { describe, it, expect } from "vitest";
import {
  getCurrency,
  getLocale,
  runWithContext,
  runWithCurrency,
  runWithLocale,
} from "../src/lib/runtime-context.js";

describe("runtime context", () => {
  it("defaults to NGN / en outside any context", () => {
    expect(getCurrency()).toBe("NGN");
    expect(getLocale()).toBe("en");
  });

  it("reads currency and locale inside a context", () => {
    runWithContext({ currency: "GHS", locale: "yoruba" }, () => {
      expect(getCurrency()).toBe("GHS");
      expect(getLocale()).toBe("yoruba");
    });
  });

  it("nests and restores the outer context", () => {
    runWithCurrency("KES", () => {
      runWithLocale("igbo", () => {
        expect(getCurrency()).toBe("KES");
        expect(getLocale()).toBe("igbo");
      });
      expect(getLocale()).toBe("en");
    });
    expect(getCurrency()).toBe("NGN");
  });
});
