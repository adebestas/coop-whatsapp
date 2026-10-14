// tests/multi-currency-integration.test.ts
import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { withCoopContext } from "../src/lib/tenant-context.js";
import { formatBalance } from "../src/lib/money.js";
import { t } from "../src/lib/i18n.js";

describe("multi-currency + multi-language integration", () => {
  it("formats and localizes inside a GHS/pidgin coop context", async () => {
    const coop = await prisma.cooperative.create({
      data: { name: "Accra Coop", code: `AC${Date.now()}`, currency: "GHS", locale: "pidgin" },
    });
    await withCoopContext(coop.id, async () => {
      expect(formatBalance(100050)).toBe("₵1,000.50");
      expect(t("money.balance")).toBe("💰 Your money wey you get");
    });
  });
});
