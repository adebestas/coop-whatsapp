import { PrismaClient, Prisma } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";

const isProd = process.env.NODE_ENV === "production";
const isTest = process.env.NODE_ENV === "test";

/**
 * Prisma client with automatic connection pooling for production.
 *
 * PRODUCTION POOL SETTINGS (auto-appended if missing from DATABASE_URL):
 *   ?connection_limit=10&pool_timeout=10
 *
 * - connection_limit: Max connections in pool. Rule: (2 × CPU cores) + 1.
 *   For higher concurrency, use PgBouncer instead of raising this value.
 * - pool_timeout: Seconds to wait for a connection before throwing.
 *
 * Graceful shutdown: pool connections are closed on process exit.
 */
function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? "";

  // For tests, use SQLite
  if (isTest) {
    return "file:./dev.db";
  }

  if (!isProd || url.includes("connection_limit")) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}connection_limit=10&pool_timeout=10`;
}

const base = new PrismaClient({
  log: isProd ? ["error", "warn"] : ["error", "warn", "info"],
  datasources: {
    db: {
      url: resolveDatabaseUrl(),
    },
  },
});

/**
 * AsyncLocalStorage carrying the transaction client for the current async
 * context, if any. When set, the exported `prisma` proxy routes every query to
 * that transaction, so a Row-Level-Security context set with
 * `set_config('app.current_cooperative_id', ..., true)` applies to all of it.
 *
 * This is what lets services keep calling `prisma.member.findMany(...)` without
 * threading a `tx` parameter through every function.
 */
export const txStorage = new AsyncLocalStorage<Prisma.TransactionClient>();

/**
 * The application's Prisma client. It is a thin proxy over the real client:
 * outside a transaction it behaves exactly like `PrismaClient`; inside one
 * (opened by `withTx` / `withCoopContext`) it transparently targets the
 * transaction's connection.
 */
export const prisma = new Proxy(base, {
  get(target, prop) {
    const src = txStorage.getStore() ?? target;
    const value = Reflect.get(src, prop, src);
    return typeof value === "function" ? value.bind(src) : value;
  },
}) as PrismaClient;

/**
 * Owner-role client for SYSTEM-LEVEL operations that legitimately need
 * cross-tenant access — the nightly backup dump, and migrations. It bypasses
 * RLS by design (the owner is not restricted unless FORCE is set).
 *
 * Uses DATABASE_OWNER_URL when set (production: the app connects as the
 * non-owner `coop_app` role, so the owner URL is separate); otherwise falls
 * back to the normal URL (local dev / tests, where the app is the owner).
 */
export const ownerPrisma = new PrismaClient({
  log: isProd ? ["error", "warn"] : ["error", "warn", "info"],
  datasources: {
    db: {
      url: process.env.DATABASE_OWNER_URL ?? resolveDatabaseUrl(),
    },
  },
});

/**
 * Run `fn` inside a transaction. If one is already open in the current async
 * context, reuse it so nested calls share the same connection and RLS context
 * (Prisma does not support nested interactive transactions).
 *
 * Inside `fn`, `prisma.*` resolves to the transaction client.
 */
export async function withTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const existing = txStorage.getStore();
  if (existing) return fn(existing);
  return base.$transaction((tx) => txStorage.run(tx, () => fn(tx)));
}

/**
 * Batch form of `withTx`: run an array of Prisma operations atomically.
 *
 * Inside an existing transaction the operations were already built against that
 * transaction's client (via the `prisma` proxy), so they are simply awaited in
 * order. Outside one, they run as a normal `$transaction([...])` batch.
 *
 * The tuple signature mirrors Prisma's own batch overload so heterogeneous
 * arrays keep their per-element result types.
 */
type UnwrapTuple<T extends readonly unknown[]> = {
  [K in keyof T]: Awaited<T[K]>;
};

export async function withTxBatch<P extends Prisma.PrismaPromise<unknown>[]>(
  ops: [...P],
): Promise<UnwrapTuple<P>> {
  const existing = txStorage.getStore();
  if (existing) {
    const out: unknown[] = [];
    for (const op of ops) out.push(await op);
    return out as UnwrapTuple<P>;
  }
  return base.$transaction(ops) as Promise<UnwrapTuple<P>>;
}

// Graceful shutdown — close pool connections on process exit
process.on("beforeExit", async () => {
  await base.$disconnect();
});
