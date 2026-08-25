import { PrismaClient } from "@prisma/client";

const isProd = process.env.NODE_ENV === "production";

export const prisma = new PrismaClient({
  log: isProd ? ["error", "warn"] : ["error", "warn", "info"],
  datasources: {
    db: {
      // Connection pooling: append ?pool_timeout=10&connection_limit=5 to DATABASE_URL
      // for production; or use PgBouncer for higher concurrency.
      url: process.env.DATABASE_URL,
    },
  },
});

// Graceful shutdown — close pool connections on exit
process.on("beforeExit", async () => {
  await prisma.$disconnect();
});
