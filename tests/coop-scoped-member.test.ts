import { describe, it, expect } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { withCoopContext } from "../src/lib/tenant-context.js";
import { withdrawLimit } from "../src/services/withdrawals.js";

/**
 * A phone can belong to more than one cooperative. Money paths must resolve the
 * member for the ACTIVE cooperative, not an arbitrary row (the old bare-phone
 * `findFirst` could pick the wrong tenant's member/wallet/books).
 */
describe("coop-scoped member resolution", () => {
  it("resolves the member for the active cooperative, not an arbitrary one", async () => {
    const phone = `+234${Date.now()}`;
    const coopA = await prisma.cooperative.create({
      data: { name: "Coop A", code: `A${Date.now()}`, currency: "NGN" },
    });
    const coopB = await prisma.cooperative.create({
      data: { name: "Coop B", code: `B${Date.now()}`, currency: "NGN" },
    });
    await prisma.member.create({
      data: {
        code: `MA${Date.now()}`,
        phone,
        name: "A member",
        cooperativeId: coopA.id,
        wallet: { create: { balance: 100_000 } },
      },
    });
    await prisma.member.create({
      data: {
        code: `MB${Date.now()}`,
        phone,
        name: "B member",
        cooperativeId: coopB.id,
        wallet: { create: { balance: 900_000 } },
      },
    });

    const a = await withCoopContext(coopA.id, async () => withdrawLimit(phone));
    expect(a?.balance).toBe(100_000);

    const b = await withCoopContext(coopB.id, async () => withdrawLimit(phone));
    expect(b?.balance).toBe(900_000);
  });
});
