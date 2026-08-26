import Redis from "ioredis";

/**
 * Redis cache layer for session caching and frequently accessed data.
 * Gracefully degrades to no-op when Redis is unavailable.
 */

const REDIS_URL = process.env.REDIS_URL;

let redis: Redis | null = null;
let isConnected = false;
let lastErrorLog = 0;

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
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      lazyConnect: true,
    });

    redis.connect().catch(() => {});

    redis.on("connect", () => {
      isConnected = true;
      console.warn("[Redis] Connected");
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
    });

    return redis;
  } catch (err) {
    console.error("[Redis] Failed to initialize:", err);
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
 * Delete all keys matching a pattern
 */
export async function cacheDelPattern(pattern: string): Promise<void> {
  const client = getRedis();
  if (!client) return;

  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) await client.del(...keys);
    } while (cursor !== '0');
  } catch (err) {
    console.error("[Redis] cacheDelPattern error:", err);
  }
}

/**
 * Check if Redis is connected
 */
export function isRedisConnected(): boolean {
  return isConnected;
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

// ===== Cache Keys =====

export const CACHE_KEYS = {
  // Session cache (5 min)
  session: (phone: string) => `session:${phone}`,

  // Member cache (5 min)
  member: (phone: string) => `member:${phone}`,
  memberById: (id: string) => `member:id:${id}`,

  // Balance cache (1 min - frequently updated)
  balance: (memberId: string) => `balance:${memberId}`,

  // Cooperative cache (10 min - rarely changes)
  coop: (coopId: string) => `coop:${coopId}`,

  // Loan cache (5 min)
  loan: (loanId: string) => `loan:${loanId}`,
  activeLoans: (memberId: string) => `loans:active:${memberId}`,

  // Rate limiting (sliding window)
  rateLimit: (phone: string) => `ratelimit:${phone}`,
  moneyRateLimit: (phone: string) => `ratelimit:money:${phone}`,

  // OTP cache (10 min)
  otp: (phone: string) => `otp:${phone}`,

  // Session data
  sessionData: (phone: string) => `session:data:${phone}`,
} as const;

// ===== TTL Constants (in seconds) =====

export const CACHE_TTL = {
  SESSION: 5 * 60, // 5 min
  MEMBER: 5 * 60, // 5 min
  BALANCE: 60, // 1 min
  COOP: 10 * 60, // 10 min
  LOAN: 5 * 60, // 5 min
  OTP: 10 * 60, // 10 min
  RATE_LIMIT: 60, // 1 min
} as const;

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
      const current = await client.eval(`
        local current = redis.call('INCR', KEYS[1])
        if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
        return current
      `, 1, redisKey, windowSeconds.toString()) as number;
      if (current > maxAttempts) {
        const ttl = await client.ttl(redisKey);
        return { allowed: false, retryAfter: ttl > 0 ? ttl : windowSeconds };
      }
      return { allowed: true };
    } catch {
      // Fall through to in-memory
    }
  }

  // Fail-closed for security-sensitive rate limits (login, money)
  if (key.startsWith("login:") || key.startsWith("pin:")) {
    return { allowed: false, retryAfter: windowSeconds };
  }
  // In-memory fallback for non-critical limits
  console.warn(`[RateLimit] Redis unavailable, using in-memory fallback for key: ${key}`);
  const isMoneyOperation = key.includes("money");
  if (isMoneyOperation) {
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
