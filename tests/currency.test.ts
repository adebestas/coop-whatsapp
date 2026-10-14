import { describe, it, expect } from "vitest";
import {
  currencyMeta,
  isSupportedCurrency,
  providersForCurrency,
  formatMoney,
  DEFAULT_CURRENCY,
} from "../src/lib/currency.js";

describe("currency registry", () => {
  it("defaults to NGN", () => {
    expect(DEFAULT_CURRENCY).toBe("NGN");
  });

  it("resolves a known currency", () => {
    expect(currencyMeta("GHS").symbol).toBe("₵");
    expect(currencyMeta("ghs").code).toBe("GHS");
  });

  it("falls back to NGN for an unknown currency", () => {
    expect(currencyMeta("XXX").code).toBe("NGN");
  });

  it("validates supported currencies", () => {
    expect(isSupportedCurrency("KES")).toBe(true);
    expect(isSupportedCurrency("kes")).toBe(true);
    expect(isSupportedCurrency("XXX")).toBe(false);
  });

  it("lists providers per currency", () => {
    expect(providersForCurrency("NGN")).toContain("monnify");
    expect(providersForCurrency("GHS")).not.toContain("monnify");
    expect(providersForCurrency("UGX")).toEqual(["flutterwave"]);
  });

  it("formats money with the right symbol and grouping", () => {
    expect(formatMoney(100050, "NGN")).toBe("₦1,000.50");
    expect(formatMoney(100050, "GHS")).toBe("₵1,000.50");
    expect(formatMoney(0, "USD")).toBe("$0.00");
  });
});
