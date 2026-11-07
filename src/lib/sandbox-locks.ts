import { randomUUID } from "node:crypto";
import { getRedis } from "./cache.js";
import { SandboxBusyError } from "./sandbox-errors.js";

const LOCK_KEY = "sandbox:lock";
const LOCK_TTL_SECONDS = 180;
const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const RENEW_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) else return 0 end';
let locallyLocked = false;
let activeTurns = 0;

async function acquireLock(): Promise<{ token: string | null }> {
  if (locallyLocked) throw new SandboxBusyError();
  locallyLocked = true;
  const client = getRedis();
  if (!client) {
    if (process.env.NODE_ENV === "production") {
      locallyLocked = false;
      throw new SandboxBusyError("sandbox requires Redis in production");
    }
    return { token: null };
  }

  const token = randomUUID();
  try {
    const result = await client.set(LOCK_KEY, token, "EX", LOCK_TTL_SECONDS, "NX");
    if (result !== "OK") throw new SandboxBusyError();
    return { token };
  } catch (error) {
    locallyLocked = false;
    if (error instanceof SandboxBusyError) throw error;
    throw new SandboxBusyError("could not acquire sandbox lock");
  }
}

async function releaseLock(token: string | null): Promise<void> {
  try {
    if (token) {
      const client = getRedis();
      if (!client) throw new Error("Redis disconnected before sandbox lock release");
      await client.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token);
    }
  } finally {
    locallyLocked = false;
  }
}

export async function withSandboxTurn<T>(fn: () => Promise<T>): Promise<T> {
  const lock = await acquireLock();
  activeTurns++;
  const heartbeat = setInterval(
    () => {
      const client = getRedis();
      if (client && lock.token) {
        void client.eval(RENEW_SCRIPT, 1, LOCK_KEY, lock.token, LOCK_TTL_SECONDS).catch((error) => {
          console.error("[sandbox] lock renewal failed", error);
        });
      }
    },
    (LOCK_TTL_SECONDS * 1000) / 3,
  );
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    activeTurns--;
    await releaseLock(lock.token);
  }
}

export async function assertNoActiveTurns(): Promise<void> {
  if (activeTurns > 0) throw new SandboxBusyError("cannot reset while a sandbox turn is active");
}

export async function withSandboxResetFlag<T>(fn: () => Promise<T>): Promise<T> {
  const lock = await acquireLock();
  const heartbeat = setInterval(
    () => {
      const client = getRedis();
      if (client && lock.token) {
        void client.eval(RENEW_SCRIPT, 1, LOCK_KEY, lock.token, LOCK_TTL_SECONDS).catch((error) => {
          console.error("[sandbox] reset lock renewal failed", error);
        });
      }
    },
    (LOCK_TTL_SECONDS * 1000) / 3,
  );
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await releaseLock(lock.token);
  }
}
