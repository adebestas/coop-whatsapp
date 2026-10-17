import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { setRate, getRate } from "../src/services/federation/fx.js";

async function makeFed() {
  return prisma.federation.create({
    data: { name: "West Africa Fed", code: `FED${Date.now()}`, baseCurrency: "NGN" },
  });
}

describe("federation FX", () => {
  it("returns 1 for the same currency", async () => {
    const fed = await makeFed();
    expect(await getRate(fed.id, "NGN", "NGN")).toBe(1);
  });

  it("returns the latest effective rate", async () => {
    const fed = await makeFed();
    await setRate(fed.id, "NGN", "GHS", 0.008, "admin");
    await setRate(fed.id, "NGN", "GHS", 0.009, "admin");
    expect(await getRate(fed.id, "NGN", "GHS")).toBeCloseTo(0.009);
  });

  it("inverts a stored rate when only the reverse exists", async () => {
    const fed = await makeFed();
    await setRate(fed.id, "NGN", "GHS", 0.008, "admin");
    expect(await getRate(fed.id, "GHS", "NGN")).toBeCloseTo(125);
  });

  it("fails closed when no rate exists", async () => {
    const fed = await makeFed();
    await expect(getRate(fed.id, "NGN", "KES")).rejects.toThrow("NO_FX_RATE");
  });
});
