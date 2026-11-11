import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { clearMemberCache } from "../src/services/cooperative.js";

const ALT = "tg:777777777";

async function makeCoop(code: string) {
  return prisma.cooperative.create({
    data: { name: `Coop ${code}`, code, adminPhone: "2348000000000" },
  });
}

async function makeMember(phone: string, coopId: string, altChannelId?: string) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role: "member",
      consentAt: new Date(),
      pin: hashPin("1234"),
      ...(altChannelId ? { altChannelId } : {}),
      wallet: { create: {} },
    },
  });
}

describe("alternate-channel owner resolution", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearMemberCache();
    await prisma.auditLog.deleteMany();
    await prisma.wallet.deleteMany();
    await prisma.member.deleteMany();
    await prisma.cooperative.deleteMany();
  });

  it("does not touch any member when the alt channel id is ambiguous across coops", async () => {
    const coopA = await makeCoop("ALTAA");
    const coopB = await makeCoop("ALTBB");
    // Insert B first so an unscoped findFirst would pick B.
    const memberB = await makeMember("2348011110002", coopB.id, ALT);
    const memberA = await makeMember("2348011110001", coopA.id, ALT);

    await handleMessage(ALT, "hello");

    const [a, b] = await Promise.all([
      prisma.member.findUnique({ where: { id: memberA.id } }),
      prisma.member.findUnique({ where: { id: memberB.id } }),
    ]);
    expect(a?.preferredChannel).toBeNull();
    expect(b?.preferredChannel).toBeNull();
  });

  it("links the unique owner's preferred channel and sends the alerts-only notice", async () => {
    const coop = await makeCoop("ALTCC");
    const member = await makeMember("2348011110003", coop.id, ALT);

    await handleMessage(ALT, "hello");

    const updated = await prisma.member.findUnique({ where: { id: member.id } });
    expect(updated?.preferredChannel).toBe("telegram");
    const texts = vi.mocked(sendText).mock.calls.map((c) => c[0].text);
    expect(texts.some((t) => t.includes("alerts"))).toBe(true);
  });
});
