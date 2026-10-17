/**
 * SEC-9: RedisMutex must guarantee single-processing.
 *
 * The old release() blindly deleted the key, so a worker whose TTL lapsed could
 * delete a SECOND worker's lock → two concurrent handlers. Now release is an
 * atomic compare-and-delete on a per-acquire owner token.
 *
 * Redis is absent in tests, so a fake client is injected via the test hook.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const store = new Map<string, string>();

const fakeRedis = {
  async set(k: string, v: string, _ex: string, _ttl: number, _nx: string) {
    if (store.has(k)) return null;
    store.set(k, v);
    return "OK";
  },
  // Fake of our two Lua scripts: only the RELEASE script (contains "del")
  // removes the key; both require the caller's token to match.
  async eval(script: string, _n: number, key: string, arg?: unknown) {
    const cur = store.get(key);
    if (cur === undefined || cur !== String(arg)) return 0;
    if (script.includes("del")) store.delete(key);
    return 1;
  },
};

import { RedisMutex } from "../src/lib/redis-mutex.js";

beforeEach(() => {
  store.clear();
  RedisMutex.__setClientForTests(fakeRedis);
});

afterEach(() => {
  RedisMutex.__setClientForTests(null);
});

describe("RedisMutex single-processing", () => {
  it("allows one holder and only the owner can release", async () => {
    const token = await RedisMutex.acquire("u1", 100);
    expect(token).toBeTruthy();

    // Second acquire times out while the lock is held.
    expect(await RedisMutex.acquire("u1", 60)).toBeNull();

    // A non-owner release must NOT drop the lock.
    await RedisMutex.release("u1", "not-the-token");
    expect(store.has("mutex:user:u1")).toBe(true);

    // The owner can release.
    await RedisMutex.release("u1", token!);
    expect(store.has("mutex:user:u1")).toBe(false);
  });

  it("withMutex runs the function and releases the lock", async () => {
    const result = await RedisMutex.withMutex("u2", async () => 42);
    expect(result).toBe(42);
    expect(store.has("mutex:user:u2")).toBe(false);
  });
});
