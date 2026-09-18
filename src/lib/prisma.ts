import { PrismaClient } from "@prisma/client";

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

export const prisma = new PrismaClient({
  log: isProd ? ["error", "warn"] : ["error", "warn", "info"],
  datasources: {
    db: {
      url: resolveDatabaseUrl(),
    },
  },
});

// Graceful shutdown — close pool connections on exit
process.on("beforeExit", async () => {
  await prisma.$disconnect();
});
