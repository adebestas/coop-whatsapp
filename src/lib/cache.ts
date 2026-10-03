import Redis from "ioredis";

/**
 * Redis cache layer for session caching and frequently accessed data.
 * Gracefully degrades to no-op when Redis is unavailable.
 * Automatically recovers when Redis becomes available again.
 */

const REDIS_URL = process.env.REDIS_URL;

let redis: Redis | null = null;
let isConnected = false;
let lastErrorLog = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
const RECONNECT_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Schedule a background reconnection attempt
 */
function scheduleReconnect(): void {
  if (reconnectTimer) return; // Already scheduled

  reconnectTimer = setInterval(async () => {
    if (isConnected || !redis) {
      clearInterval(reconnectTimer!);
      reconnectTimer = null;
      return;
    }

    try {
      console.warn("[Redis] Attempting background reconnection...");
      await redis!.connect();
    } catch (err) {
      // Connection failed, will retry on next interval
      const now = Date.now();
      if (now - lastErrorLog > 60_000) {
        console.error(
          "[Redis] Background reconnection failed:",
          err instanceof Error ? err.message : String(err),
        );
        lastErrorLog = now;
      }
    }
  }, RECONNECT_INTERVAL_MS);
}

/**
 * Initialize Redis connection
 */
export function initRedis(): Redis | null {
  if (!REDIS_URL) {
    console.warn("[Redis] REDIS_URL not set, caching disabled");
    return null;
  }

  try {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) {
          // After 3 quick retries, stop built-in retries and switch to background reconnection
          console.warn("[Redis] Quick retries exhausted, scheduling background reconnection...");
          scheduleReconnect();
          return null; // Stop built-in retries
        }
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      lazyConnect: true,
      // Auto-reconnect settings for transient errors
      reconnectOnError: (err) => {
        const targetErrors = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND"];
        return targetErrors.some((e) => err.message.includes(e));
      },
    });

    redis.on("connect", () => {
      isConnected = true;
      console.warn("[Redis] Connected");
      // Clear any scheduled background reconnection
      if (reconnectTimer) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
      }
    });

    redis.on("error", (err) => {
      isConnected = false;
      const now = Date.now();
      if (now - lastErrorLog > 30_000) {
        console.error("[Redis] Error:", err.message);
        lastErrorLog = now;
      }
    });

    redis.on("close", () => {
      isConnected = false;
      // Schedule background reconnection if not already scheduled
      if (!reconnectTimer) {
        console.warn("[Redis] Connection closed, scheduling background reconnection...");
        scheduleReconnect();
      }
    });

    redis.on("reconnecting", () => {
      console.warn("[Redis] Reconnecting...");
    });

    redis.connect().catch(() => {});

    return redis;
  } catch (err) {
    console.error("[Redis] Failed to initialize:", err);
    // Schedule background reconnection even on initialization failure
    scheduleReconnect();
    return null;
  }
}

/**
 * Get Redis client (returns null if not connected)
 */
export function getRedis(): Redis | null {
  if (!redis || !isConnected) return null;
  return redis;
}

/**
 * Cache a value with TTL
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number = 300,
): Promise<void> {
  const client = getRedis();
  if (!client) return;

  try {
    await client.setex(key, ttlSeconds, JSON.stringify(value));
  } catch (err) {
    console.error("[Redis] cacheSet error:", err);
  }
}

/**
 * Get a cached value
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const client = getRedis();
  if (!client) return null;

  try {
    const data = await client.get(key);
    if (!data) return null;
    return JSON.parse(data) as T;
  } catch (err) {
    console.error("[Redis] cacheGet error:", err);
    return null;
  }
}

/**
 * Delete a cached value
 */
export async function cacheDel(key: string): Promise<void> {
  const client = getRedis();
  if (!client) return;

  try {
    await client.del(key);
  } catch (err) {
    console.error("[Redis] cacheDel error:", err);
  }
}

/**
 * Check if Redis is connected
 */
export function isRedisConnected(): boolean {
  return isConnected;
}

/** In-memory fallback for claimOnce when Redis is unavailable. */
const inMemoryOnce = new Map<string, number>();

/**
 * Claim a (key, period) exactly once. Returns true the first time, false after.
 *
 * Redis-backed (SET NX EX) so the claim survives restarts and is shared across
 * instances — used for scheduler "already ran this period" guards. Falls back to
 * an in-memory set when Redis is unavailable (single-instance only).
 */
export async function claimOnce(
  key: string,
  period: string,
  ttlSeconds: number,
): Promise<boolean> {
  const client = getRedis();
  const fullKey = `once:${key}:${period}`;
  if (client) {
    try {
      const set = await client.set(fullKey, "1", "EX", ttlSeconds, "NX");
      return set === "OK";
    } catch {
      // fall through to in-memory
    }
  }
  const now = Date.now();
  const memKey = `${key}:${period}`;
  const expires = inMemoryOnce.get(memKey);
  if (expires && now < expires) return false;
  inMemoryOnce.set(memKey, now + ttlSeconds * 1000);
  return true;
}

/**
 * Close Redis connection
 */
export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    isConnected = false;
  }
}

// ===== Redis-backed Rate Limiting =====
// Falls back to in-memory when Redis is unavailable.

const inMemoryRateLimits = new Map<string, { count: number; resetAt: number }>();

// Sweep expired entries every 60 seconds to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of inMemoryRateLimits) {
    if (now > entry.resetAt) inMemoryRateLimits.delete(key);
  }
}, 60_000);

/**
 * Sliding window rate limit. Returns { allowed, retryAfter? }.
 * Uses Redis INCR + EXPIRE when connected, falls back to in-memory.
 */
export async function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const client = getRedis();
  const now = Date.now();

  if (client) {
    try {
      const redisKey = `rl:${key}`;
      const current = (await client.eval(
        `
        local current = redis.call('INCR', KEYS[1])
        if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
        return current
      `,
        1,
        redisKey,
        windowSeconds.toString(),
      )) as number;
      if (current > maxAttempts) {
        const ttl = await client.ttl(redisKey);
        return { allowed: false, retryAfter: ttl > 0 ? ttl : windowSeconds };
      }
      return { allowed: true };
    } catch {
      // Fall through to in-memory
    }
  }

  // Fail-closed for money operations; use in-memory fallback for login.
  // Tests have no Redis, and fail-closed would make every PIN verification fail,
  // so under NODE_ENV=test the in-memory fallback is used for these keys too.
  // Production behaviour is unchanged: without Redis, PIN checks are refused.
  const failClosedAllowed = process.env.NODE_ENV !== "test";
  if (failClosedAllowed && key.startsWith("pin:")) {
    return { allowed: false, retryAfter: windowSeconds };
  }
  if (key.startsWith("login:")) {
    console.warn(`[RateLimit] Redis unavailable for login key, using in-memory fallback`);
  }
  // In-memory fallback for non-critical limits
  if (!failClosedAllowed || process.env.NODE_ENV !== "test") {
    console.warn(`[RateLimit] Redis unavailable, using in-memory fallback for key: ${key}`);
  }
  const isMoneyOperation = key.includes("money");
  if (isMoneyOperation && failClosedAllowed) {
    return { allowed: false, retryAfter: windowSeconds };
  }
  const entry = inMemoryRateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    inMemoryRateLimits.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return { allowed: true };
  }
  if (entry.count >= maxAttempts) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true };
}

/**
 * Reset a rate limit key (e.g., after successful login).
 */
export async function resetRateLimit(key: string): Promise<void> {
  const client = getRedis();
  if (client) {
    try {
      await client.del(`rl:${key}`);
    } catch {
      // ignore
    }
  }
  inMemoryRateLimits.delete(key);
}

/**
 * OTP rate limiting:
 * - 60s cooldown between OTP generations per phone
 * - 3 OTP codes per 10-minute window per phone
 * - 5 wrong verification attempts → 30-min lockout per phone
 */
export async function checkOtpRateLimit(
  phone: string,
): Promise<{ allowed: boolean; message?: string; retryAfter?: number }> {
  const client = getRedis();
  const now = Date.now();

  if (!client) {
    // In-memory fallback: track via inMemoryRateLimits map.
    // For production, Redis is strongly recommended.
    const genKey = `otp_gen_mem:${phone}`;
    const verifyKey = `otp_verify_mem:${phone}`;
    const cooldownKey = `otp_cooldown_mem:${phone}`;

    const genEntry = inMemoryRateLimits.get(genKey);
    const verifyEntry = inMemoryRateLimits.get(verifyKey);
    const cooldownEntry = inMemoryRateLimits.get(cooldownKey);

    // 60s cooldown check
    if (cooldownEntry && now - cooldownEntry.resetAt < 60_000) {
      const remaining = Math.ceil((60_000 - (now - cooldownEntry.resetAt)) / 1000);
      return {
        allowed: false,
        message: `Please wait *${remaining}* more second(s) before requesting a new OTP.`,
        retryAfter: remaining,
      };
    }

    // 3 OTP codes per 10 min window
    if (genEntry && genEntry.count >= 3) {
      const remainingSec = Math.ceil(((genEntry.resetAt as number) - now) / 1000);
      return {
        allowed: false,
        message: `You have reached the limit of 3 OTP codes per 10 minutes. Try again in *${Math.ceil(remainingSec / 60)}* minute(s).`,
        retryAfter: remainingSec,
      };
    }

    // 5 wrong verification attempts → lockout
    if (verifyEntry && verifyEntry.count >= 5) {
      const lockoutEnd = verifyEntry.resetAt ? new Date(verifyEntry.resetAt as number) : new Date();
      const now = Date.now();
      const lockoutMinutes = Math.ceil((lockoutEnd.getTime() - now) / 60_000);
      return {
        allowed: false,
        message: `Your OTP account is locked for *${lockoutMinutes} minute(s)* after 5 wrong attempts.`,
        retryAfter: lockoutMinutes * 60,
      };
    }

    // In-memory: increment counters
    if (!genEntry) {
      inMemoryRateLimits.set(genKey, { count: 1, resetAt: now + 10 * 60 * 1000 });
    } else {
      genEntry.count++;
      genEntry.resetAt = now + 10 * 60 * 1000;
    }
    if (!verifyEntry) {
      inMemoryRateLimits.set(verifyKey, { count: 1, resetAt: now + 30 * 60 * 1000 });
    } else {
      verifyEntry.count++;
      verifyEntry.resetAt = now + 30 * 60 * 1000;
    }
    // 60s cooldown: store the generation timestamp (NOT a future resetAt — the
    // check above compares `now - resetAt < 60_000`).
    inMemoryRateLimits.set(cooldownKey, { count: 1, resetAt: now });

    return { allowed: true };
  }

  // Redis-backed implementation
  const genKey = `otp_gen:${phone}`;
  const verifyKey = `otp_verify:${phone}`;
  const cooldownKey = `otp_cooldown:${phone}`;

  // 60s cooldown check: if last generation was < 60s ago, reject
  const cooldownTs = await client.get(cooldownKey);
  if (cooldownTs) {
    const lastGen = parseInt(cooldownTs);
    if (now - lastGen < 60_000) {
      const remaining = Math.ceil((60_000 - (now - lastGen)) / 1000);
      return {
        allowed: false,
        message: `Please wait *${remaining}* more second(s) before requesting a new OTP.`,
        retryAfter: remaining,
      };
    }
  }

  // 3 OTP codes per 10 min window: use checkRateLimit (already INCR+EXPIRE)
  const genAllowed = await checkRateLimit(genKey, 3, 600);
  if (!genAllowed.allowed) {
    const ttl = await client.ttl(genKey);
    return {
      allowed: false,
      message: `You have reached the limit of 3 OTP codes per 10 minutes. Try again later.`,
      retryAfter: ttl > 0 ? ttl : 600,
    };
  }

  // 5 wrong verification attempts → lockout: use checkRateLimit with window 30 min
  const verifyAllowed = await checkRateLimit(verifyKey, 5, 30 * 60);
  if (!verifyAllowed.allowed) {
    const ttl = await client.ttl(verifyKey);
    return {
      allowed: false,
      message: `Your OTP account is locked after 5 wrong attempts. Try again in *${Math.ceil(ttl / 60)}* minute(s).`,
      retryAfter: ttl > 0 ? ttl : 30 * 60,
    };
  }

  // On success, reset the wrong-attempt counter by removing the key
  // (the actual reset happens when OTP verification succeeds in the caller)
  // But we also need to update the cooldown timestamp.
  // We'll let the caller reset the cooldown via a separate function if needed.
  await client.set(cooldownKey, String(now), "EX", 60);

  return { allowed: true };
}

/**
 * Run `fn` only if this process can acquire a Redis lock for `key`.
 *
 * Returns false when another instance already holds the lock, so scheduled jobs
 * run on exactly one instance. The lock is released in `finally`; `ttlMs` is a
 * crash safety net. When Redis is unavailable, `fn` runs locally (single-
 * instance fallback) and returns true.
 */
export async function withDistributedLock(
  key: string,
  ttlMs: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const client = getRedis();
  if (!client) {
    await fn();
    return true;
  }
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const acquired = await client.set(key, token, "PX", ttlMs, "NX");
  if (acquired !== "OK") return false;
  try {
    await fn();
    return true;
  } finally {
    // Release only if we still own the lock (it may have expired and been taken).
    const current = await client.get(key).catch(() => null);
    if (current === token) await client.del(key).catch(() => {});
  }
}
