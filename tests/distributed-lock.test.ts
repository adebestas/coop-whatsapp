import { describe, expect, it } from "vitest";
import { withDistributedLock } from "../src/lib/cache.js";

/**
 * In the test environment Redis is unavailable, so withDistributedLock takes
 * the single-instance fallback path: it runs fn locally and returns true. The
 * Redis mutual-exclusion path is exercised in production.
 */
describe("withDistributedLock", () => {
  it("runs fn and returns true when Redis is unavailable (single-instance fallback)", async () => {
    let ran = 0;
    const result = await withDistributedLock("test:lock", 1000, async () => {
      ran++;
    });
    expect(result).toBe(true);
    expect(ran).toBe(1);
  });

  it("propagates fn errors", async () => {
    await expect(
      withDistributedLock("test:lock2", 1000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
