/**
 * A15: AI-processing consent (NDPR).
 *
 * Voice-note transcription and non-English translation both send the member's
 * content to a third-party LLM (Groq). They must run only after the member is
 * resolved AND has consented to AI processing — never before, and never for a
 * member who declined.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../tests/setup.js";
import { createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";
import { invalidateMemberCache } from "../src/services/cooperative.js";

const GROQ_CHAT = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_AUDIO = "https://api.groq.com/openai/v1/audio/transcriptions";

function textsSent(): string {
  return vi
    .mocked(sendText)
    .mock.calls.map((c) => String((c[0] as { text?: string }).text))
    .join("\n");
}

function fetchUrls(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls.map((c) => String(c[0]));
}

async function stateOf(phone: string) {
  return (await prisma.session.findUnique({ where: { phone } }))?.state;
}

beforeEach(async () => {
  await cleanupDatabase();
  vi.clearAllMocks();
  process.env.GROQ_API_KEY = "test-key";
  process.env.WHATSAPP_TOKEN = "wa-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GROQ_API_KEY;
  delete process.env.WHATSAPP_TOKEN;
});

describe("AI processing consent", () => {
  it("does not send a voice note to Groq without consent — it prompts instead", async () => {
    const coop = await createTestCoop("AIC1");
    const m = await createTestMember(coop.id, { phone: "2348000700001" });
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchSpy);

    await handleMessage(m.phone, "", { audioMediaId: "media-1" });

    expect(fetchUrls(fetchSpy)).not.toContain(GROQ_AUDIO);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await stateOf(m.phone)).toBe("awaiting_ai_consent");
    expect(textsSent()).toMatch(/AI processing/i);
  });

  it("transcribes a voice note only once the member has consented", async () => {
    const coop = await createTestCoop("AIC2");
    const m = await createTestMember(coop.id, { phone: "2348000700002" });
    await prisma.member.update({ where: { id: m.id }, data: { aiConsentAt: new Date() } });
    invalidateMemberCache(m.phone);

    const fetchSpy = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("graph.facebook.com")) {
        return { ok: true, json: async () => ({ url: "https://media/x", mime_type: "audio/ogg" }) };
      }
      if (url === "https://media/x")
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
      if (url === GROQ_AUDIO) {
        return { ok: true, json: async () => ({ text: "balance", language: "en" }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchSpy);

    await handleMessage(m.phone, "", { audioMediaId: "media-1" });

    expect(fetchUrls(fetchSpy)).toContain(GROQ_AUDIO);
    expect(textsSent()).toMatch(/balance/i);
  });

  it("does not translate a non-English message without consent — it prompts", async () => {
    const coop = await createTestCoop("AIC3");
    const m = await createTestMember(coop.id, { phone: "2348000700003" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await handleMessage(m.phone, "bawo ni owo mi?");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await stateOf(m.phone)).toBe("awaiting_ai_consent");
    expect(textsSent()).toMatch(/AI processing/i);
  });

  it("translates a non-English message once the member has consented", async () => {
    const coop = await createTestCoop("AIC4");
    const m = await createTestMember(coop.id, { phone: "2348000700004" });
    await prisma.member.update({ where: { id: m.id }, data: { aiConsentAt: new Date() } });
    invalidateMemberCache(m.phone);

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "what is my balance" } }] }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await handleMessage(m.phone, "bawo ni owo mi?");

    expect(fetchUrls(fetchSpy)).toContain(GROQ_CHAT);
  });

  it("records consent when the member replies YES", async () => {
    const coop = await createTestCoop("AIC5");
    const m = await createTestMember(coop.id, { phone: "2348000700005" });
    await prisma.session.create({
      data: {
        phone: m.phone,
        state: "awaiting_ai_consent",
        data: JSON.stringify({ memberId: m.id }),
      },
    });

    await handleMessage(m.phone, "yes");

    const updated = await prisma.member.findUnique({ where: { id: m.id } });
    expect(updated?.aiConsentAt).not.toBeNull();
    const consent = await prisma.dataConsent.findFirst({
      where: { memberId: m.id, consentType: "ai_processing" },
    });
    expect(consent?.granted).toBe(true);
    expect(await stateOf(m.phone)).toBe("idle");
  });

  it("records a decline on NO and never re-prompts", async () => {
    const coop = await createTestCoop("AIC6");
    const m = await createTestMember(coop.id, { phone: "2348000700006" });
    await prisma.session.create({
      data: {
        phone: m.phone,
        state: "awaiting_ai_consent",
        data: JSON.stringify({ memberId: m.id }),
      },
    });

    await handleMessage(m.phone, "no");

    expect((await prisma.member.findUnique({ where: { id: m.id } }))?.aiConsentAt).toBeNull();
    const consent = await prisma.dataConsent.findFirst({
      where: { memberId: m.id, consentType: "ai_processing" },
    });
    expect(consent?.granted).toBe(false);

    // A later non-English message must NOT re-ask; it tells them AI is off.
    vi.clearAllMocks();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await handleMessage(m.phone, "bawo ni owo mi?");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await stateOf(m.phone)).toBe("idle");
    expect(textsSent()).not.toMatch(/Reply \*YES\*/i);
    expect(textsSent()).toMatch(/aioptin/i);
  });

  it("re-enables AI processing with *aioptin*", async () => {
    const coop = await createTestCoop("AIC7");
    const m = await createTestMember(coop.id, { phone: "2348000700007" });

    await handleMessage(m.phone, "aioptin");

    expect((await prisma.member.findUnique({ where: { id: m.id } }))?.aiConsentAt).not.toBeNull();
    const consent = await prisma.dataConsent.findFirst({
      where: { memberId: m.id, consentType: "ai_processing" },
    });
    expect(consent?.granted).toBe(true);
  });
});
