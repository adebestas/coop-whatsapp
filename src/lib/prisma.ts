import { PrismaClient } from "@prisma/client";

const isProd = process.env.NODE_ENV === "production";

export const prisma = new PrismaClient({
  log: isProd ? ["error", "warn"] : ["error", "warn", "info"],
  datasources: {
    db: {
      // Connection pooling: PgBouncer-style pool for production, simple for dev/test
      url: process.env.DATABASE_URL,
    },
  },
});

// Graceful shutdown — close pool connections on exit
process.on("beforeExit", async () => {
  await prisma.$disconnect();
});
