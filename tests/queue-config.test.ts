/**
 * OPS-2: queue retries. Retries must be configured as JOB options
 * (`attempts`/`backoff`), not Worker options — the removed `maxStartedAttempts`
 * key was never a BullMQ option, so failed jobs were silently never retried.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_JOB_OPTIONS } from "../src/lib/queue.js";

describe("queue retry configuration", () => {
  it("retries failed jobs more than once with exponential backoff", () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_JOB_OPTIONS.backoff).toEqual({
      type: "exponential",
      delay: expect.any(Number),
    });
  });

  it("keeps failed jobs long enough to inspect, evicts completed sooner", () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toMatchObject({ age: expect.any(Number) });
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toMatchObject({ age: expect.any(Number) });
  });

  it("does not rely on the non-existent maxStartedAttempts option", () => {
    const src = readFileSync(new URL("../src/lib/queue.ts", import.meta.url), "utf8");
    // Match it used as an option key (a comment referencing the removed key is fine).
    expect(src).not.toMatch(/^\s*maxStartedAttempts\s*:/m);
  });
});
