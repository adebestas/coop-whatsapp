import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import { sendText } from "../src/lib/messaging.js";
import { clearMemberCache } from "../src/services/cooperative.js";
import { handleMessage } from "../src/services/conversation.js";
import { parseSchemeItem } from "../src/services/commodity-commands.js";

const SUPER = "2348090000400";
const ADMIN = "2348090000401";
const MEMBER = "2348090000402";

function lastText(): string {
  const calls = vi.mocked(sendText).mock.calls;
  return calls.length ? (calls[calls.length - 1][0] as { text: string }).text : "";
}

async function wipe(table: string) {
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  } catch {}
}

beforeEach(async () => {
  vi.stubEnv("COMMODITY_SCHEMES_ENABLED", "1");
  for (const t of [
    "session",
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
  clearMemberCache();
  vi.mocked(sendText).mockClear();
});

afterEach(() => vi.unstubAllEnvs());

async function seed() {
  const coop = await prisma.cooperative.create({
    data: { name: "Cmd Coop", code: `CM${Date.now()}` },
  });
  const superM = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: SUPER,
      name: "Super",
      code: "CSU1",
      role: "superadmin",
      status: "active",
      consentAt: new Date(),
      wallet: { create: {} },
    },
  });
  const admin = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: ADMIN,
      name: "Admin",
      code: "CAD1",
      role: "admin",
      status: "active",
      consentAt: new Date(),
      wallet: { create: {} },
    },
  });
  const member = await prisma.member.create({
    data: {
      cooperativeId: coop.id,
      phone: MEMBER,
      name: "Member",
      code: "CME1",
      role: "member",
      status: "active",
      consentAt: new Date(),
      wallet: { create: {} },
    },
  });
  await prisma.deductionBatch.create({
    data: {
      cooperativeId: coop.id,
      ref: `DED-${new Date().toISOString().slice(0, 7)}-CMD1`,
      totalAmount: 10_000,
      sourceFileKey: "schedules/cmd.xlsx",
      createdById: admin.id,
      items: { create: [{ memberId: member.id, kind: "savings", amount: 10_000 }] },
    },
  });
  return { coop, superM, admin, member };
}

describe("commodity WhatsApp commands", () => {
  it("creates and opens a scheme from admin chat", async () => {
    await seed();
    await handleMessage(SUPER, "newscheme Christmas 2026 | Christmas | 2026-10-01 | 2099-12-31");
    expect(lastText()).toContain("SCH-");
    const scheme = await prisma.commodityScheme.findFirst();
    await handleMessage(
      SUPER,
      `addschemeitem ${scheme!.reference} | Rice 50kg | bag | 800 | 900 | 10 | 2`,
    );
    expect(lastText()).toContain("Added");
    await handleMessage(ADMIN, `openscheme ${scheme!.reference}`);
    const fresh = await prisma.commodityScheme.findUnique({ where: { id: scheme!.id } });
    expect(fresh!.status).toBe("open");
  });

  it("shows credit and subscribes from member chat", async () => {
    const { member } = await seed();
    await handleMessage(SUPER, "newscheme Ileya 2027 | Ileya | 2026-10-01 | 2099-12-31");
    const scheme = await prisma.commodityScheme.findFirst();
    await handleMessage(
      SUPER,
      `addschemeitem ${scheme!.reference} | Ram | ram | 100 | 200 | 5 | 1`,
    );
    await handleMessage(ADMIN, `openscheme ${scheme!.reference}`);

    await handleMessage(MEMBER, "credit");
    expect(lastText()).toContain("30");
    await handleMessage(MEMBER, `subscribe ${scheme!.reference} Ram 1 3`);
    expect(lastText()).toContain("Reserved");
    const sub = await prisma.commoditySubscription.findFirst();
    expect(sub!.memberId).toBe(member.id);

    await handleMessage(MEMBER, "mysubs");
    expect(lastText()).toContain(sub!.reference);
    await handleMessage(MEMBER, "schemes");
    expect(lastText()).toContain("Ram");
  });

  it("replies with the disabled message when the feature flag is off", async () => {
    vi.stubEnv("COMMODITY_SCHEMES_ENABLED", "0");
    await seed();
    await handleMessage(MEMBER, "schemes");
    expect(lastText()).toContain("not enabled");
  });
});

describe("parseSchemeItem", () => {
  it("parses pipe-delimited items and defaults an empty unit to unit", () => {
    expect(parseSchemeItem("addschemeitem SCH-1 | Palm Oil |  | 1,200 | 1,500 | - | 3")).toEqual({
      name: "Palm Oil",
      unitLabel: "unit",
      unitCostKobo: 120_000,
      memberPriceKobo: 150_000,
      totalUnits: null,
      maxQtyPerMember: 3,
    });
  });

  it("rejects malformed rows", () => {
    expect(parseSchemeItem("addschemeitem SCH-1 | Rice | bag | abc | 900 | 10 | 2")).toBeNull();
    expect(parseSchemeItem("addschemeitem SCH-1 | Rice | bag | 800 | 900")).toBeNull();
  });
});
