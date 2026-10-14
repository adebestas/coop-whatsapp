import { describe, it, expect, vi } from "vitest";

// tests/setup.ts globally mocks this module and stubs resolveProvider to a fake
// monnify adapter. Restore the real implementation for this file so the currency
// routing under test is actually exercised.
vi.mock("../src/services/payments/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/payments/index.js")>();
  return { ...actual };
});

import { resolveProvider } from "../src/services/payments/index.js";

describe("resolveProvider by currency", () => {
  it("returns a provider that supports the currency", async () => {
    const p = await resolveProvider(undefined, "GHS");
    expect(["paystack", "flutterwave"]).toContain(p.name);
  });
  it("never returns monnify for a non-NGN currency", async () => {
    const p = await resolveProvider("monnify", "GHS");
    expect(p.name).not.toBe("monnify");
  });
  it("still returns monnify for NGN", async () => {
    const p = await resolveProvider("monnify", "NGN");
    expect(p.name).toBe("monnify");
  });
});
