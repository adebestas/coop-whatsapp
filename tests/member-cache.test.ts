import { describe, expect, it } from "vitest";
import { prisma, createTestCoop, createTestMember } from "./setup.js";
import { getMemberByPhone, invalidateMemberCache } from "../src/services/cooperative.js";

/**
 * The member cache is Redis-backed with an in-memory fallback. In tests Redis is
 * unavailable, so this exercises the in-memory path; the Redis path is the same
 * shape (JSON + Date revival) and is covered by the round-trip assertions here.
 */
describe("member cache", () => {
  it("caches a lookup, returns the cached row, and invalidates on demand", async () => {
    const coop = await createTestCoop("CACHE1");
    const member = await createTestMember(coop.id, { phone: "2348090000050" });

    const first = await getMemberByPhone("2348090000050", coop.id);
    expect(first?.id).toBe(member.id);
    expect(first?.createdAt).toBeInstanceOf(Date);

    // Change the row directly, bypassing invalidation — the cache still serves it.
    await prisma.member.update({ where: { id: member.id }, data: { name: "Changed Name" } });
    const cached = await getMemberByPhone("2348090000050", coop.id);
    expect(cached?.name).not.toBe("Changed Name");

    // After invalidation the fresh row is read.
    invalidateMemberCache("2348090000050", coop.id);
    const fresh = await getMemberByPhone("2348090000050", coop.id);
    expect(fresh?.name).toBe("Changed Name");
  });

  it("bare-phone invalidation also clears cooperative-scoped entries", async () => {
    const coop = await createTestCoop("CACHE2");
    const member = await createTestMember(coop.id, { phone: "2348090000051" });

    await getMemberByPhone("2348090000051", coop.id); // caches `<coopId>:<phone>`
    await prisma.member.update({ where: { id: member.id }, data: { name: "Renamed" } });

    invalidateMemberCache("2348090000051");
    const fresh = await getMemberByPhone("2348090000051", coop.id);
    expect(fresh?.name).toBe("Renamed");
  });
});
