import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { withCoopContext, invalidateCoopMeta } from "../src/lib/tenant-context.js";
import { getCurrency, getLocale } from "../src/lib/runtime-context.js";

describe("withCoopContext sets currency/locale", () => {
  let coopId: string;

  beforeEach(async () => {
    const coop = await prisma.cooperative.create({
      data: { name: "Ghana Coop", code: `GH${Date.now()}`, currency: "GHS", locale: "pidgin" },
    });
    coopId = coop.id;
    invalidateCoopMeta(coopId);
  });

  it("exposes the coop currency + locale inside the context", async () => {
    await withCoopContext(coopId, async () => {
      expect(getCurrency()).toBe("GHS");
      expect(getLocale()).toBe("pidgin");
    });
  });

  it("restores the default outside the context", async () => {
    await withCoopContext(coopId, async () => {});
    expect(getCurrency()).toBe("NGN");
    expect(getLocale()).toBe("en");
  });
});
