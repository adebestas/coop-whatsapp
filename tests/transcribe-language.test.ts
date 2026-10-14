import { describe, it, expect, vi, afterEach } from "vitest";
import { localeFromLanguageCode } from "../src/lib/i18n.js";
import { transcribeAudioMessage } from "../src/lib/transcribe.js";

describe("localeFromLanguageCode", () => {
  it("maps Whisper ISO codes to locales", () => {
    expect(localeFromLanguageCode("yo")).toBe("yoruba");
    expect(localeFromLanguageCode("ha")).toBe("hausa");
    expect(localeFromLanguageCode("ig")).toBe("igbo");
    expect(localeFromLanguageCode("en")).toBe("en");
    expect(localeFromLanguageCode("pcm")).toBe("pidgin");
  });
  it("returns null for unknown/empty codes", () => {
    expect(localeFromLanguageCode("fr")).toBeNull();
    expect(localeFromLanguageCode("")).toBeNull();
    expect(localeFromLanguageCode(undefined)).toBeNull();
  });
});

describe("transcribeAudioMessage", () => {
  const origKey = process.env.GROQ_API_KEY;
  const origToken = process.env.WHATSAPP_TOKEN;
  const origFetch = global.fetch;
  afterEach(() => {
    process.env.GROQ_API_KEY = origKey;
    process.env.WHATSAPP_TOKEN = origToken;
    global.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("returns the transcript text and the detected language", async () => {
    process.env.GROQ_API_KEY = "test";
    process.env.WHATSAPP_TOKEN = "test";
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://x/audio", mime_type: "audio/ogg" }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ text: "bawo ni", language: "yo" }) }) as unknown as typeof fetch;
    expect(await transcribeAudioMessage("media-1")).toEqual({ text: "bawo ni", language: "yo" });
  });
});
