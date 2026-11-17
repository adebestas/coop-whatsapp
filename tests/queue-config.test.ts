/**
 * OPS-2: queue retries. Retries must be configured as JOB options
 * (`attempts`/`backoff`), not Worker options - the removed `maxStartedAttempts`
 * key was never a BullMQ option, so failed jobs were silently never retried.
 *
 * Also guards the worker connection rule: BullMQ blocking commands reject a
 * client with `maxRetriesPerRequest` set, and the shared cache client sets it
 * to 3. Passing that client crashed the process at boot (`BullMQ: Your redis
 * options maxRetriesPerRequest must be null`), so every scheduled job died.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const captures = vi.hoisted(() => ({ workerOptions: [] as unknown[] }));

vi.mock("bullmq", () => {
  class Worker {
    constructor(_name: string, _processor: unknown, options: unknown) {
      captures.workerOptions.push(options);
    }
    on(): void {}
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  class Queue {
    constructor() {}
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  class Job {}
  return { Worker, Queue, Job };
});

const fakeRedis = {
  duplicate: (options: Record<string, unknown>) => ({ duplicated: true, ...options }),
};

vi.mock("../src/lib/cache.js", () => ({
  getRedis: () => fakeRedis,
}));

vi.resetModules();
const { DEFAULT_JOB_OPTIONS, processQueue } = await import("../src/lib/queue.js");

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

  it("gives the worker a blocking connection, not the shared cache client", () => {
    processQueue("notifications", async () => {});

    const options = captures.workerOptions.at(-1) as { connection: unknown };
    expect(options.connection).not.toBe(fakeRedis);
    expect(options.connection).toMatchObject({
      duplicated: true,
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
  });
});
