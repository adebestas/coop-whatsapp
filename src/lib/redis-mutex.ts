import crypto from "node:crypto";
import { getRedis } from "./cache.js";

// Compare-and-delete: only removes the lock if it is still OURS. Prevents a
// worker whose TTL lapsed from deleting another worker's lock.
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;
// Compare-and-expire: renew the lock while we still hold it.
const RENEW_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end`;

/**
 * Redis-backed distributed mutex for per-user message serialization.
 * Prevents race conditions where two messages from the same user
 * are processed concurrently across multiple instances.
 *
 * Single-processing guarantee: the lock is held under a unique owner token and
 * released via an atomic compare-and-delete, and it is renewed (heartbeat) while
 * `fn` runs so a slow handler cannot lose the lock to a second worker.
 */
export class RedisMutex {
  private static PREFIX = "mutex:user:";
  private static DEFAULT_TTL_SECONDS = 30; // Max time to hold mutex
  /** Test-only client override (Redis is unavailable in unit tests). */
  private static clientOverride: unknown = null;

  static __setClientForTests(client: unknown): void {
    this.clientOverride = client;
  }

  private static client(): ReturnType<typeof getRedis> {
    return (this.clientOverride as ReturnType<typeof getRedis>) ?? getRedis();
  }

  /**
   * Acquire a mutex for the given key (e.g., phone number).
   * Waits until the mutex is available or timeout is reached.
   *
   * @param key - Unique identifier for the mutex (e.g., "2348012345678")
   * @param timeoutMs - Maximum time to wait for mutex acquisition
   * @returns the owner token if acquired, or null on timeout / no Redis
   */
  static async acquire(key: string, timeoutMs: number = 10_000): Promise<string | null> {
    const client = this.client();
    if (!client) {
      // No Redis available - fail closed for money operations
      console.warn("[RedisMutex] Redis unavailable, cannot acquire mutex");
      return null;
    }

    const mutexKey = `${this.PREFIX}${key}`;
    const token = crypto.randomUUID();
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      // SET NX EX is atomic: only the first caller gets "OK".
      const result = await client.set(mutexKey, token, "EX", this.DEFAULT_TTL_SECONDS, "NX");
      if (result === "OK") return token;

      await new Promise((r) => setTimeout(r, 50));
    }

    console.warn(`[RedisMutex] Timeout acquiring mutex for ${key}`);
    return null;
  }

  /** Renew OUR lock's TTL. No-op if we no longer hold it. */
  static async renew(key: string, token: string): Promise<void> {
    const client = this.client();
    if (!client) return;
    const mutexKey = `${this.PREFIX}${key}`;
    await client.eval(RENEW_SCRIPT, 1, mutexKey, token, this.DEFAULT_TTL_SECONDS).catch(() => {});
  }

  /**
   * Release a previously acquired mutex — ONLY if we still own it (atomic
   * compare-and-delete). Never deletes another worker's lock.
   */
  static async release(key: string, token: string): Promise<void> {
    const client = this.client();
    if (!client) return;
    const mutexKey = `${this.PREFIX}${key}`;
    await client.eval(RELEASE_SCRIPT, 1, mutexKey, token).catch(() => {});
  }

  /**
   * Execute a function with a mutex held.
   * Automatically acquires and releases the mutex, renewing it while `fn` runs.
   *
   * @param key - Unique identifier for the mutex
   * @param fn - Async function to execute while holding mutex
   * @param timeoutMs - Max time to wait for mutex
   * @returns Result of fn, or throws if mutex could not be acquired
   */
  static async withMutex<T>(
    key: string,
    fn: () => Promise<T>,
    timeoutMs: number = 10_000,
  ): Promise<T> {
    const token = await this.acquire(key, timeoutMs);
    if (!token) {
      throw new Error(`Could not acquire mutex for ${key} within ${timeoutMs}ms`);
    }

    // Heartbeat: renew at half the TTL so a long-running handler keeps the lock.
    const heartbeat = setInterval(
      () => void this.renew(key, token),
      (this.DEFAULT_TTL_SECONDS * 1000) / 2,
    );
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      await this.release(key, token);
    }
  }
}

/**
 * Redis-backed circuit breaker for payment provider availability.
 * Tracks provider failures and automatically routes to fallback providers.
 */
export class RedisCircuitBreaker {
  private static PREFIX = "circuit:provider:";
  private static DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Mark a provider as down (unavailable) for a cooldown period.
   */
  static async markDown(
    name: string,
    cooldownMs: number = this.DEFAULT_COOLDOWN_MS,
  ): Promise<void> {
    const client = getRedis();
    if (!client) return;

    const key = `${this.PREFIX}${name.toLowerCase()}`;
    const ttlSeconds = Math.ceil(cooldownMs / 1000);
    await client.set(key, Date.now().toString(), "EX", ttlSeconds).catch(() => {});
  }

  /**
   * Mark a provider as up (available) again.
   */
  static async markUp(name: string): Promise<void> {
    const client = getRedis();
    if (!client) return;

    const key = `${this.PREFIX}${name.toLowerCase()}`;
    await client.del(key).catch(() => {});
  }

  /**
   * Check if a provider is currently available (not in cooldown).
   */
  static async isAvailable(name: string): Promise<boolean> {
    const client = getRedis();
    if (!client) return true; // Fail-open if Redis unavailable

    const key = `${this.PREFIX}${name.toLowerCase()}`;
    const exists = await client.exists(key);
    return exists === 0;
  }

  /**
   * Get remaining cooldown time in milliseconds.
   */
  static async getCooldownRemaining(name: string): Promise<number> {
    const client = getRedis();
    if (!client) return 0;

    const key = `${this.PREFIX}${name.toLowerCase()}`;
    const ttl = await client.ttl(key);
    return ttl > 0 ? ttl * 1000 : 0;
  }
}

export { getRedis };
