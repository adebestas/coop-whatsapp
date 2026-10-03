import { describe, expect, it } from "vitest";
import { prisma, createTestCoop, createTestMember } from "./setup.js";
import { prisma as appPrisma } from "../src/lib/prisma.js";
import {
  resolveCoopByPhone,
  resolveCoopByAltChannel,
  withCoopContext,
} from "../src/lib/tenant-context.js";

/**
 * Tenant-context helpers.
 *
 * On SQLite (local dev + this suite) there is no RLS and no `app` schema, so
 * resolveCoopByPhone / resolveCoopByAltChannel fall back to direct queries and
 * withCoopContext's GUC write is a no-op. These tests pin the fail-closed
 * semantics that the Postgres SECURITY DEFINER resolvers must also honour:
 * unknown -> null, ambiguous (phone in >1 coop) -> null.
 *
 * The Postgres path (app.resolve_coop_by_phone) is exercised by
 * tests/rls-isolation.test.ts when RLS_ENABLED=1.
 */
describe("tenant-context resolvers (SQLite fallback)", () => {
  it("resolves a phone that belongs to exactly one cooperative", async () => {
    const coop = await createTestCoop("RESOLVE1");
    const member = await createTestMember(coop.id, { phone: "2348090000001" });

    expect(await resolveCoopByPhone(member.phone)).toBe(coop.id);
  });

  it("returns null for an unknown phone", async () => {
    expect(await resolveCoopByPhone("2348000000000")).toBeNull();
  });

  it("returns null when a phone is registered in more than one cooperative", async () => {
    const coopA = await createTestCoop("RESOLVE2A");
    const coopB = await createTestCoop("RESOLVE2B");
    const phone = "2348090000002";
    await createTestMember(coopA.id, { phone });
    await createTestMember(coopB.id, { phone });

    expect(await resolveCoopByPhone(phone)).toBeNull();
  });

  it("resolves an alternate channel id to its cooperative", async () => {
    const coop = await createTestCoop("RESOLVE3");
    const member = await createTestMember(coop.id, { phone: "2348090000003" });
    await prisma.member.update({
      where: { id: member.id },
      data: { altChannelId: "tg:999000111" },
    });

    expect(await resolveCoopByAltChannel("tg:999000111")).toBe(coop.id);
    expect(await resolveCoopByAltChannel("tg:does-not-exist")).toBeNull();
  });

  it("withCoopContext runs the callback and returns its value (GUC is a no-op on SQLite)", async () => {
    const coop = await createTestCoop("RESOLVE4");
    const result = await withCoopContext(coop.id, async (tx) => {
      const count = await tx.member.count({ where: { cooperativeId: coop.id } });
      return count;
    });
    expect(result).toBe(0);
  });

  it("routes prisma.* through the transaction inside withCoopContext (rolls back on throw)", async () => {
    const coop = await createTestCoop("RESOLVE5");
    const phone = "2348090000005";

    await expect(
      withCoopContext(coop.id, async () => {
        // Uses the app's `prisma` proxy, NOT the tx argument. If the proxy did
        // not route to the transaction, this write would commit and survive.
        await appPrisma.member.create({
          data: { name: "Tx Member", phone, code: "TXROLLBACK", cooperativeId: coop.id },
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const found = await appPrisma.member.findUnique({
      where: { cooperativeId_phone: { cooperativeId: coop.id, phone } },
    });
    expect(found).toBeNull();
  });
});
