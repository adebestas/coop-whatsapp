import { afterEach, describe, expect, it, vi } from "vitest";

/** cache.ts reads REDIS_URL at module load, so reset the registry per case. */
async function loadCache(redisUrl: string | undefined) {
  vi.resetModules();
  if (redisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = redisUrl;
  return import("../src/lib/cache.js");
}

describe("Redis readiness", () => {
  const original = process.env.REDIS_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = original;
    vi.resetModules();
  });

  it("reports memory-only mode when REDIS_URL is not configured", async () => {
    const cache = await loadCache(undefined);
    expect(cache.isRedisConfigured()).toBe(false);
    await expect(cache.waitForRedisReady(200)).resolves.toBe(false);
  });

  it("fails to become ready when the configured Redis is unreachable", async () => {
    const cache = await loadCache("redis://127.0.0.1:6399");
    expect(cache.isRedisConfigured()).toBe(true);
    cache.initRedis();
    await expect(cache.waitForRedisReady(700)).resolves.toBe(false);
    await cache.closeRedis();
  });
});
