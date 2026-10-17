/**
 * PERF-4: the per-member AI budget caps Groq spend (chat + voice + translation).
 * Redis is absent in tests, so the in-memory fallback is exercised.
 */
import { describe, expect, it } from "vitest";
import { checkAIRateLimit } from "../src/services/fraud.js";

const MAX = 10; // default AI_MAX_PER_HOUR

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("checkAIRateLimit", () => {
  it("allows the budget and blocks the next request", async () => {
    const id = uniqueId("member");
    let allowed = 0;
    for (let i = 0; i < MAX; i++) {
      if (await checkAIRateLimit(id)) allowed++;
    }
    expect(allowed).toBe(MAX);
    expect(await checkAIRateLimit(id)).toBe(false);
  });

  it("counts independently per member", async () => {
    const busy = uniqueId("busy");
    const fresh = uniqueId("fresh");
    for (let i = 0; i < MAX; i++) await checkAIRateLimit(busy);

    expect(await checkAIRateLimit(busy)).toBe(false);
    expect(await checkAIRateLimit(fresh)).toBe(true);
  });
});
