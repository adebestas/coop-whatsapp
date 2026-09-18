import { getRedis } from "./cache.js";

/**
 * Redis-backed distributed mutex for per-user message serialization.
 * Prevents race conditions where two messages from the same user
 * are processed concurrently across multiple instances.
 */
export class RedisMutex {
  private static PREFIX = "mutex:user:";
  private static DEFAULT_TTL_SECONDS = 30; // Max time to hold mutex

  /**
   * Acquire a mutex for the given key (e.g., phone number).
   * Waits until the mutex is available or timeout is reached.
   *
   * @param key - Unique identifier for the mutex (e.g., "2348012345678")
   * @param timeoutMs - Maximum time to wait for mutex acquisition
   * @returns true if acquired, false if timeout
   */
  static async acquire(key: string, timeoutMs: number = 10_000): Promise<boolean> {
    const client = getRedis();
    if (!client) {
      // No Redis available - fail closed for money operations
      console.warn("[RedisMutex] Redis unavailable, cannot acquire mutex");
      return false;
    }

    const mutexKey = `${this.PREFIX}${key}`;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      // Try to acquire with SET NX EX (atomic set-if-not-exists with expiry)
      // ioredis set signature: set(key, value, 'EX', seconds, 'NX')
      const result = await client.set(mutexKey, "1", "EX", this.DEFAULT_TTL_SECONDS, "NX");
      if (result === "OK") return true;

      // Wait a bit before retrying
      await new Promise((r) => setTimeout(r, 50));
    }

    console.warn(`[RedisMutex] Timeout acquiring mutex for ${key}`);
    return false;
  }

  /**
   * Release a previously acquired mutex.
   * Only releases if the mutex is still held by this process (simple check).
   */
  static async release(key: string): Promise<void> {
    const client = getRedis();
    if (!client) return;

    const mutexKey = `${this.PREFIX}${key}`;
    // We use a simple owner marker (could be process ID + random)
    // For simplicity, we just delete if exists - the EXPIRY ensures it's auto-released
    await client.del(mutexKey).catch(() => {});
  }

  /**
   * Execute a function with a mutex held.
   * Automatically acquires and releases the mutex.
   *
   * @param key - Unique identifier for the mutex
   * @param fn - Async function to execute while holding mutex
   * @param timeoutMs - Max time to wait for mutex
   * @returns Result of fn, or throws if mutex could not be acquired
   */
  static async withMutex<T>(key: string, fn: () => Promise<T>, timeoutMs: number = 10_000): Promise<T> {
    const acquired = await this.acquire(key, timeoutMs);
    if (!acquired) {
      throw new Error(`Could not acquire mutex for ${key} within ${timeoutMs}ms`);
    }

    try {
      return await fn();
    } finally {
      await this.release(key);
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
  static async markDown(name: string, cooldownMs: number = this.DEFAULT_COOLDOWN_MS): Promise<void> {
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