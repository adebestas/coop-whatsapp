import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
  notifyMember: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
  sendSecurePrompt: vi.fn().mockResolvedValue(true),
}));

import { prisma, cleanupDatabase } from "../tests/setup.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { clearMemberCache } from "../src/services/cooperative.js";
import { createFederation, addMember } from "../src/services/federation/index.js";

const PHONE = "2348012345601";

async function makeCoop(code: string, fund: number) {
  return prisma.cooperative.create({
    data: { name: `Coop ${code}`, code, currency: "NGN", federationFundBalance: fund },
  });
}

async function makeMember(phone: string, coopId: string, role: string) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role,
      consentAt: new Date(),
      pin: hashPin("1234"),
      wallet: { create: {} },
    },
  });
}

async function setup(fund = 10_000_000) {
  const fed = await createFederation("Coop Fed", `FED${Date.now()}`, "NGN");
  const coop = await makeCoop(`FC${Date.now()}`, fund);
  await addMember(fed.id, coop.id);
  const admin = await makeMember(PHONE, coop.id, "admin");
  return { fed, coop, admin };
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearMemberCache();
  await cleanupDatabase();
});

describe("coop federation commands", () => {
  it("lets a coop admin contribute to the pool", async () => {
    const { coop } = await setup();

    await handleMessage(PHONE, "federation contribute 1000");

    const updated = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(updated!.federationFundBalance).toBe(9_900_000);
  });

  it("shows the coop's federation position", async () => {
    const { fed, coop } = await setup();

    await handleMessage(PHONE, "federation contribute 1000");
    vi.mocked(sendText).mockClear();
    await handleMessage(PHONE, "federation position");

    const reply = vi.mocked(sendText).mock.calls.at(-1)![0].text;
    expect(reply).toContain(fed.name);
    expect(reply).toContain("Pool stake");
    expect(reply).toContain("1,000");

    const position = await prisma.federationPosting.count({
      where: { cooperativeId: coop.id },
    });
    expect(position).toBeGreaterThan(0);
  });

  it("does not shadow the super-admin federation commands", async () => {
    const fed = await createFederation("Coop Fed", `FED${Date.now()}`, "NGN");
    const coop = await makeCoop(`FC${Date.now()}`, 10_000_000);
    await addMember(fed.id, coop.id);
    const superPhone = "2348012345699";
    await makeMember(superPhone, coop.id, "superadmin");

    await handleMessage(superPhone, "federation create shadowfed NGN");

    const created = await prisma.federation.findFirst({ where: { name: "shadowfed" } });
    expect(created).toBeTruthy();
    expect(created?.baseCurrency).toBe("NGN");
  });
});
