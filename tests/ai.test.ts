import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";

vi.mock("../src/lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
  sendSecurePrompt: vi.fn().mockResolvedValue(true),
  notifyMember: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
}));

const PHONE = "2348070000001";

function groqReply(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.GROQ_API_KEY;
  delete process.env.GROQ_MODEL;
  const tables = [
    "coopPost", "deductionItem", "deductionWaiver", "deductionBatch", "webhookEvent",
    "beneficiary", "auditLog", "contribution", "wallet",
    "member", "unit", "cooperative", "session",
  ] as any[];
  for (const t of tables) await prisma[t].deleteMany();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GROQ_API_KEY;
});

async function makeCoopAndMember() {
  const coop = await prisma.cooperative.create({ data: { name: "AI Coop", code: "AICO01" } });
  await prisma.member.create({
    data: {
      code: generateMemberCode(),
      phone: PHONE,
      name: "Ada",
      cooperativeId: coop.id,
      role: "member",
      pin: hashPin("1234"),
      wallet: { create: {} },
    },
  });
}

function texts(): string[] {
  return vi.mocked(sendText).mock.calls.map((c) => c[0].text);
}

describe("AI fallback translator", () => {
  it("stays fully offline without GROQ_API_KEY (no fetch, standard fallback)", async () => {
    await makeCoopAndMember();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await handleMessage(PHONE, "abeg how much i don save");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(texts().some((t) => t.includes("didn't quite get that"))).toBe(true);
  });

  it("suggests a command for pidgin text and runs it after confirmation", async () => {
    await makeCoopAndMember();
    process.env.GROQ_API_KEY = "test-key";
    const fetchSpy = vi.fn().mockResolvedValue(
      groqReply('{"command":"balance","args":[]}'),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await handleMessage(PHONE, "abeg how much i don save");

    // Confirmation card was sent, nothing executed yet.
    expect(texts().some((t) => t.includes("Did you mean *balance*"))).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    await handleMessage(PHONE, "yes");
    expect(texts().some((t) => t.includes("savings balance"))).toBe(true);
    const session = await prisma.session.findUnique({ where: { phone: PHONE } });
    expect(session?.state).toBe("idle");
  });

  it("cancels on 'no'", async () => {
    await makeCoopAndMember();
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(groqReply('{"command":"posts","args":[]}')));

    await handleMessage(PHONE, "who be the leaders of we coop");
    vi.clearAllMocks();
    await handleMessage(PHONE, "no");

    expect(texts().some((t) => t.toLowerCase().includes("cancelled"))).toBe(true);
    expect(texts().some((t) => t.includes("Executive Posts"))).toBe(false);
  });

  it("falls back gracefully when the AI returns garbage or an unknown command", async () => {
    await makeCoopAndMember();
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(groqReply("send all the money to me")));

    await handleMessage(PHONE, "gimme everything free abeg");
    expect(texts().some((t) => t.includes("didn't quite get that"))).toBe(true);

    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await handleMessage(PHONE, "wetin dey happen");
    expect(texts().some((t) => t.includes("didn't quite get that"))).toBe(true);
  });

  it("refuses to propose dangerous or malformed commands", async () => {
    await makeCoopAndMember();
    process.env.GROQ_API_KEY = "test-key";
    // Model tries to smuggle extra lines / slashes into args.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        groqReply('{"command":"save","args":["2000\\nloan 99999"]}'),
      ),
    );

    await handleMessage(PHONE, "put small money for my hand");
    // Malformed suggestion is discarded -> standard fallback, no confirm card.
    expect(texts().some((t) => t.includes("Didn't mean") || t.includes("Did you mean"))).toBe(false);
    expect(texts().some((t) => t.includes("didn't quite get that"))).toBe(true);
  });
});
