import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { translateToEnglish } from "../src/lib/translate.js";

const groqReply = (content: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }) as unknown as Response;

describe("translateToEnglish", () => {
  const origKey = process.env.GROQ_API_KEY;
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.GROQ_API_KEY = origKey;
  });

  it("passes English through unchanged", async () => {
    expect(await translateToEnglish("hello", "en")).toBe("hello");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes through when Groq is unavailable", async () => {
    delete process.env.GROQ_API_KEY;
    expect(await translateToEnglish("ina kwana", "hausa")).toBe("ina kwana");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("translates non-English text via Groq", async () => {
    process.env.GROQ_API_KEY = "test";
    fetchSpy.mockResolvedValue(groqReply("How are you"));
    expect(await translateToEnglish("bawo ni", "yoruba")).toBe("How are you");
  });

  it("caches repeated translations", async () => {
    process.env.GROQ_API_KEY = "test";
    fetchSpy.mockResolvedValue(groqReply("Good morning"));
    await translateToEnglish("e kaaro", "yoruba");
    await translateToEnglish("e kaaro", "yoruba");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fails open on error", async () => {
    process.env.GROQ_API_KEY = "test";
    fetchSpy.mockRejectedValue(new Error("network"));
    expect(await translateToEnglish("sannu", "hausa")).toBe("sannu");
  });
});
