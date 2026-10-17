import { afterEach, describe, expect, it, vi } from "vitest";
import { accountMismatchWarning } from "../src/lib/ai-notice.js";

function groqReply(content: string) {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GROQ_API_KEY;
});

describe("accountMismatchWarning", () => {
  it("returns the fixed fallback and never calls the network when AI is disabled", async () => {
    delete process.env.GROQ_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const text = await accountMismatchWarning("Bisi Borrower", "ADA OBI");

    expect(text).toContain("ADA OBI");
    expect(text).toContain("Bisi Borrower");
    expect(text).toMatch(/does not match/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the AI-written warning when AI is enabled", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        groqReply(
          "⚠️ Heads up, Bisi! The account name (ADA OBI) doesn't match your registered name (Bisi Borrower).",
        ),
      ),
    );

    const text = await accountMismatchWarning("Bisi Borrower", "ADA OBI");

    expect(text).toContain("ADA OBI");
    expect(text).toContain("Bisi Borrower");
  });

  it("falls back to the fixed message when the AI call fails", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) }),
    );

    const text = await accountMismatchWarning("Bisi Borrower", "ADA OBI");

    expect(text).toMatch(/does not match/i);
    expect(text).toContain("ADA OBI");
  });
});