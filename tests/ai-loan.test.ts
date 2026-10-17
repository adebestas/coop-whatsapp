import { afterEach, describe, expect, it, vi } from "vitest";

// ai-loan uses raw fetch (like lib/ai.ts suggestCommand) — no DB needed.
import { extractLoanRequest } from "../src/lib/ai-loan.js";

function groqReply(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GROQ_API_KEY;
});

describe("extractLoanRequest", () => {
  it("returns null and never calls the network when AI is disabled", async () => {
    delete process.env.GROQ_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await extractLoanRequest("i need a loan of 150k");

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("extracts amount, months and guarantors from a natural message", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        groqReply(
          '{"loan":{"amount":150000,"months":3,"guarantors":["08031234567","ABC123-XYZ"]}}',
        ),
      ),
    );

    const result = await extractLoanRequest(
      "i need a loan of 150k for 3 months, guarantors 08031234567 and ABC123-XYZ",
    );

    expect(result).toEqual({
      amountNaira: 150000,
      months: 3,
      guarantors: ["08031234567", "ABC123-XYZ"],
    });
  });

  it("returns null when the model says it is not a loan request", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(groqReply('{"loan":null}')));

    expect(await extractLoanRequest("how much have i saved this month")).toBeNull();
  });

  it("coerces numeric strings and keeps only in-range values", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        groqReply('{"loan":{"amount":"150000","months":"3","guarantors":[]}}'),
      ),
    );

    expect(await extractLoanRequest("loan pls")).toEqual({
      amountNaira: 150000,
      months: 3,
      guarantors: [],
    });
  });

  it("nulls out an out-of-range month count and a non-positive amount", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        groqReply('{"loan":{"amount":-5,"months":24,"guarantors":[]}}'),
      ),
    );

    expect(await extractLoanRequest("loan")).toEqual({
      amountNaira: null,
      months: null,
      guarantors: [],
    });
  });

  it("drops unsafe or duplicate guarantor identifiers", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        groqReply(
          '{"loan":{"amount":150000,"months":3,"guarantors":["ABC123-XYZ","ABC123-XYZ","bad\\nentry","/etc/passwd"]}}',
        ),
      ),
    );

    const result = await extractLoanRequest("loan");
    expect(result?.guarantors).toEqual(["ABC123-XYZ"]);
  });

  it("returns null on malformed JSON or an unknown shape", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(groqReply("not json at all")));

    expect(await extractLoanRequest("loan")).toBeNull();
  });

  it("returns null when the network fails", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    expect(await extractLoanRequest("loan")).toBeNull();
  });
});
