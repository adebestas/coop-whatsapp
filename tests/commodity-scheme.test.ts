import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import { notifyMember } from "../src/lib/messaging.js";
import {
  createScheme,
  addSchemeItem,
  openScheme,
  closeScheme,
  subscribeCommodity,
  cancelCommoditySubscription,
  rejectCommoditySubscription,
} from "../src/services/commodity-schemes.js";

const SUPER = "2348090000100";
const ADMIN = "2348090000101";
const MEMBER = "2348090000102";

async function wipe(table: string) {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  } catch {}
}

beforeEach(async () => {
  vi.stubEnv("COMMODITY_SCHEMES_ENABLED", "1");
  vi.stubEnv("COMMODITY_CREDIT_MULTIPLIER", "3");
  for (const t of [
    "deductionShortfall",
    "deductionItem",
    "deductionBatch",
    "commoditySubscription",
    "commoditySchemeItem",
    "commodityScheme",
    "loan",
    "wallet",
    "member",
    "cooperative",
  ]) {
    await wipe(t);
  }
  vi.mocked(notifyMember).mockClear();
});

afterEach(() => vi.unstubAllEnvs());

async function seed() {
  const coop = await prisma.cooperative.create({
    data: { name: "Scheme Coop", code: `SM${Date.now()}${Math.floor(Math.random() * 1000)}` },
  });
  const superM = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: SUPER,
      name: "Super",
      code: "SS001",
      role: "superadmin",
      status: "active",
      wallet: { create: {} },
    },
  });
  const admin = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: ADMIN,
      name: "Admin",
      code: "SA001",
      role: "admin",
      status: "active",
      wallet: { create: {} },
    },
  });
  const member = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: MEMBER,
      name: "Member",
      code: "SM001",
      role: "member",
      status: "active",
      wallet: { create: {} },
    },
  });
  const batch = await prisma.deductionBatch.create({
    data: {
      cooperativeId: coop.id,
      ref: `DED-${new Date().toISOString().slice(0, 7)}-SCH1`,
      totalAmount: 10_000,
      sourceFileKey: "schedules/oct.xlsx",
      sourceFileName: "oct.xlsx",
      createdById: admin.id,
      items: { create: [{ memberId: member.id, kind: "savings", amount: 10_000 }] },
    },
  });
  return { coop, superM, admin, member, batch };
}

async function makeOpenScheme(superPhone: string) {
  const created = await createScheme(superPhone, {
    name: "Christmas 2026",
    season: "Christmas",
    opensAt: new Date("2025-01-01T00:00:00Z"),
    closesAt: new Date("2099-12-31T00:00:00Z"),
  });
  const added = await addSchemeItem(superPhone, created.ref!, {
    name: "Rice 50kg",
    unitLabel: "bag",
    unitCostKobo: 8_000_000,
    memberPriceKobo: 9_000_000,
    totalUnits: 10,
    maxQtyPerMember: 2,
  });
  return { scheme: created, item: added };
}

describe("commodity schemes", () => {
  it("creates a scheme with an item and opens it", async () => {
    const { superM, admin } = await seed();
    const { scheme, item } = await makeOpenScheme(SUPER);
    expect(scheme.ok).toBe(true);
    expect(item.ok).toBe(true);
    const opened = await openScheme(ADMIN, scheme.ref!);
    expect(opened.ok).toBe(true);
    const fresh = await prisma.commodityScheme.findUnique({
      where: { reference: scheme.ref! },
      include: { items: true },
    });
    expect(fresh!.status).toBe("open");
    expect(fresh!.items).toHaveLength(1);
    expect(await prisma.commodityScheme.count({ where: { createdById: superM.id } })).toBe(1);
    expect(admin.role).toBe("admin");
  });

  it("rejects a subscription over the credit cap", async () => {
    const { member } = await seed();
    const { scheme, item } = await makeOpenScheme(SUPER);
    await openScheme(ADMIN, scheme.ref!);
    // cap = 10,000 x 3 = 30,000; two bags cost 18,000,000
    const res = await subscribeCommodity(MEMBER, scheme.ref!, item.ref ?? "Rice 50kg", 2, 3);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("credit");
    expect(await prisma.commoditySubscription.count()).toBe(0);
    expect(member.role).toBe("member");
  });

  it("reserves credit and notifies the member", async () => {
    const { member } = await seed();
    const { scheme, item } = await makeOpenScheme(SUPER);
    await openScheme(ADMIN, scheme.ref!);
    await prisma.commoditySchemeItem.update({
      where: { id: (await prisma.commoditySchemeItem.findFirst())!.id },
      data: { memberPriceKobo: 5_000 },
    });
    const res = await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 2, 3);
    expect(res.ok).toBe(true);
    const sub = await prisma.commoditySubscription.findFirst();
    expect(sub!.status).toBe("reserved");
    expect(sub!.totalKobo).toBe(10_000);
    expect(vi.mocked(notifyMember)).toHaveBeenCalled();
    expect(member.id).toBeTruthy();
    expect(item.ok).toBe(true);
  });

  it("blocks the third bag when max per member is two", async () => {
    await seed();
    const { scheme } = await makeOpenScheme(SUPER);
    await openScheme(ADMIN, scheme.ref!);
    await prisma.commoditySchemeItem.updateMany({ data: { memberPriceKobo: 1_000 } });
    expect((await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 2, 3)).ok).toBe(true);
    const third = await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 1, 3);
    expect(third.ok).toBe(false);
    expect(third.message).toContain("maximum");
  });

  it("releases credit on member cancel and on admin reject", async () => {
    await seed();
    const { scheme } = await makeOpenScheme(SUPER);
    await openScheme(ADMIN, scheme.ref!);
    await prisma.commoditySchemeItem.updateMany({ data: { memberPriceKobo: 1_000 } });
    const first = await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 1, 3);
    const cancelled = await cancelCommoditySubscription(MEMBER, first.ref!);
    expect(cancelled.ok).toBe(true);
    const second = await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 1, 3);
    const rejected = await rejectCommoditySubscription(ADMIN, second.ref!, "duplicate");
    expect(rejected.ok).toBe(true);
    const rows = await prisma.commoditySubscription.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "rejected"]);
  });

  it("refuses subscriptions after the scheme closes", async () => {
    await seed();
    const { scheme } = await makeOpenScheme(SUPER);
    await openScheme(ADMIN, scheme.ref!);
    await prisma.commoditySchemeItem.updateMany({ data: { memberPriceKobo: 1_000 } });
    await closeScheme(ADMIN, scheme.ref!);
    const res = await subscribeCommodity(MEMBER, scheme.ref!, "Rice 50kg", 1, 3);
    expect(res.ok).toBe(false);
    expect(res.message.toLowerCase()).toContain("closed");
  });
});
