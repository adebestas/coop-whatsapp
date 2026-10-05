import { describe, expect, it } from "vitest";
import { prisma, createTestCoop, createTestMember } from "./setup.js";
import { prisma as appPrisma } from "../src/lib/prisma.js";
import {
  resolveCoopByPhone,
  resolveCoopByAltChannel,
  resolveCoopsByPhone,
  resolveCoopByCode,
  resolveCoopByVirtualAccount,
  resolveCoopByPayoutReference,
  listCooperativeIds,
  forEachCoop,
  withCoopContext,
  rlsEnforcementStatus,
} from "../src/lib/tenant-context.js";
import { withDeferredSends, enqueueDeferredSend } from "../src/lib/deferred.js";

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

  it("lists every cooperative a phone belongs to", async () => {
    const coopA = await createTestCoop("MULTI1");
    const coopB = await createTestCoop("MULTI2");
    const phone = "2348090000010";
    await createTestMember(coopA.id, { phone });
    await createTestMember(coopB.id, { phone });

    const coops = await resolveCoopsByPhone(phone);
    expect(coops.map((c) => c.id).sort()).toEqual([coopA.id, coopB.id].sort());
    expect(coops.every((c) => c.name.length > 0 && c.code.length > 0)).toBe(true);

    expect(await resolveCoopsByPhone("2348000000000")).toEqual([]);
  });

  it("resolves a cooperative by join code", async () => {
    const coop = await createTestCoop("CODE1");
    expect(await resolveCoopByCode("CODE1")).toBe(coop.id);
    expect(await resolveCoopByCode("NOPE")).toBeNull();
  });

  it("resolves a cooperative by virtual account and payout reference", async () => {
    const coop = await createTestCoop("VA1");
    const member = await createTestMember(coop.id, { phone: "2348090000021" });
    await prisma.member.update({
      where: { id: member.id },
      data: { virtualAccountNumber: "555000111" },
    });
    expect(await resolveCoopByVirtualAccount("555000111")).toBe(coop.id);
    expect(await resolveCoopByVirtualAccount("000000000")).toBeNull();

    await prisma.payout.create({
      data: {
        amount: 1000,
        reference: "REF-1",
        idempotencyKey: "REF-1",
        status: "successful",
        memberId: member.id,
        cooperativeId: coop.id,
      },
    });
    expect(await resolveCoopByPayoutReference("REF-1")).toBe(coop.id);
    expect(await resolveCoopByPayoutReference("NOPE")).toBeNull();
  });

  it("lists cooperatives and iterates them with forEachCoop", async () => {
    const coop = await createTestCoop("LIST1");
    const ids = await listCooperativeIds();
    expect(ids).toContain(coop.id);

    const seen: string[] = [];
    await forEachCoop(async (id) => {
      seen.push(id);
    });
    expect(seen).toContain(coop.id);
  });

  it("reports RLS as not enforced on SQLite", async () => {
    const status = await rlsEnforcementStatus();
    expect(status.postgres).toBe(false);
    expect(status.enforced).toBe(false);
  });

  it("withCoopContext runs the callback and returns its value (GUC is a no-op on SQLite)", async () => {
    const coop = await createTestCoop("RESOLVE4");
    const result = await withCoopContext(coop.id, async (tx) => {
      const count = await tx.member.count({ where: { cooperativeId: coop.id } });
      return count;
    });
    expect(result).toBe(0);
  });

  it("withDeferredSends queues sends and flushes them after fn resolves", async () => {
    const order: string[] = [];
    await withDeferredSends(async () => {
      order.push("start");
      enqueueDeferredSend(async () => {
        order.push("send");
      });
      order.push("end");
    });
    order.push("after");
    expect(order).toEqual(["start", "end", "send", "after"]);
  });

  it("withCoopContext does not hold the transaction during a slow send", async () => {
    const coop = await createTestCoop("DEFER2");
    let txDone = false;
    const start = Date.now();
    // The deferred send outlives Prisma's 5s interactive-transaction timeout.
    // If the transaction spanned it, withCoopContext would reject with P2028.
    await withCoopContext(coop.id, async () => {
      enqueueDeferredSend(() => new Promise((r) => setTimeout(r, 5500)));
      txDone = true;
    });
    expect(txDone).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(5500);
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
