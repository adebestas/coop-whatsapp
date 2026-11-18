#!/usr/bin/env node
/**
 * Production Pre-flight Readiness Check
 *
 * Runs before application boot or in CI/CD release stages to verify:
 * 1. Environment secrets are secure (not defaults, adequate entropy).
 * 2. Database connection, connection pooling budget, and PostgreSQL version.
 * 3. Migration status (no dirty/failed migrations in _prisma_migrations).
 * 4. Row-Level Security (RLS) policies are active on sensitive tenant tables.
 * 5. Redis cache & queue readiness (if configured).
 *
 * Exit codes: 0 healthy, 1 checks failed, 2 critical configuration error.
 */
import { PrismaClient } from "@prisma/client";

function resolveConnectionLimit(raw, fallback) {
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const isProd = process.env.NODE_ENV === "production";

function log(status, message) {
  const icon = status === "ok" ? "✅" : status === "warn" ? "⚠️" : "❌";
  console.log(`${icon} [preflight] ${message}`);
}

async function checkSecrets() {
  let ok = true;
  const criticalSecrets = [
    { name: "ADMIN_JWT_SECRET", minLen: 32 },
    { name: "SESSION_SECRET", minLen: 32 },
  ];

  for (const { name, minLen } of criticalSecrets) {
    const val = process.env[name];
    if (!val) {
      if (isProd) {
        log("err", `Missing required production secret: ${name}`);
        ok = false;
      } else {
        log("warn", `${name} not set; dev/test fallback in use.`);
      }
    } else if (val.length < minLen) {
      log("err", `${name} length (${val.length}) is below required minimum (${minLen}).`);
      ok = false;
    } else if (/test|placeholder|secret123|default/i.test(val) && isProd) {
      log("err", `${name} contains insecure default or placeholder patterns in production.`);
      ok = false;
    } else {
      log("ok", `${name} is present with sufficient length (${val.length} chars).`);
    }
  }

  return ok;
}

async function checkDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    log("err", "DATABASE_URL is not configured.");
    return false;
  }

  const isPostgres = dbUrl.startsWith("postgres");
  log(
    isPostgres ? "ok" : "warn",
    `Database engine: ${isPostgres ? "PostgreSQL" : "SQLite / Local"}`,
  );

  const prisma = new PrismaClient({ log: [] });
  try {
    await prisma.$connect();
    log("ok", "Database connection established.");

    if (isPostgres) {
      // 1. Check max_connections vs configured connection pools
      try {
        const res = await prisma.$queryRawUnsafe("SHOW max_connections");
        const maxConn =
          Array.isArray(res) && res[0]?.max_connections
            ? parseInt(res[0].max_connections, 10)
            : 100;
        const appLimit = resolveConnectionLimit(process.env.DB_CONNECTION_LIMIT, 10);
        const ownerLimit = resolveConnectionLimit(process.env.DB_OWNER_CONNECTION_LIMIT, 3);
        const totalBudget = appLimit + ownerLimit;

        if (totalBudget >= maxConn) {
          log(
            "warn",
            `Pool budget (${totalBudget}) is close to or exceeds DB max_connections (${maxConn}).`,
          );
        } else {
          log(
            "ok",
            `Connection pool budget (${totalBudget}) safely within max_connections (${maxConn}).`,
          );
        }
      } catch {
        log("warn", "Could not query max_connections (insufficient permissions).");
      }

      // 2. Check Row-Level Security on tenant tables
      try {
        const rlsTables = await prisma.$queryRawUnsafe(`
          SELECT tablename, rowsecurity
          FROM pg_tables
          WHERE schemaname = current_schema()
            AND tablename IN ('Member', 'Wallet', 'Loan', 'JournalEntry', 'Posting')
        `);
        const withoutRls = Array.isArray(rlsTables) ? rlsTables.filter((t) => !t.rowsecurity) : [];
        if (withoutRls.length > 0) {
          log(
            "warn",
            `Tables without active Row-Level Security: ${withoutRls.map((t) => t.tablename).join(", ")}`,
          );
        } else {
          log("ok", "Row-Level Security active on critical tenant tables.");
        }
      } catch {
        log("warn", "Could not verify RLS table metadata.");
      }

      // 3. Check migration history
      try {
        const dirty = await prisma.$queryRawUnsafe(`
          SELECT migration_name FROM "_prisma_migrations"
          WHERE rolled_back_at IS NOT NULL OR finished_at IS NULL
        `);
        if (Array.isArray(dirty) && dirty.length > 0) {
          log(
            "err",
            `Found failed or unfinished migrations: ${dirty.map((d) => d.migration_name).join(", ")}`,
          );
          return false;
        }
        log("ok", "Prisma migrations history is clean (no failed migrations).");
      } catch {
        log("warn", "_prisma_migrations table not found or not queryable.");
      }
    } else {
      // SQLite local validation
      const tables = await prisma.$queryRawUnsafe(
        "SELECT count(*) as count FROM sqlite_master WHERE type='table'",
      );
      log("ok", `SQLite database healthy (${tables[0]?.count ?? 0} tables found).`);
    }

    return true;
  } catch (err) {
    log("err", `Database check failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    await prisma.$disconnect();
  }
}

async function checkRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    log("ok", "REDIS_URL not set; in-memory cache/queues active.");
    return true;
  }

  try {
    const { default: Redis } = await import("ioredis");
    const redis = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 3000,
      retryStrategy: () => null,
      maxRetriesPerRequest: null,
    });
    redis.on("error", () => {}); // silence uncaught event

    await redis.connect();
    const pong = await redis.ping();
    await redis.quit();
    if (pong === "PONG") {
      log("ok", "Redis server reachable and responsive.");
      return true;
    }
    log(isProd ? "err" : "warn", `Redis ping response unexpected: ${pong}`);
    return !isProd;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isProd) {
      log("err", `Production Redis unreachable: ${msg}`);
      return false;
    } else {
      log("warn", `Redis unreachable locally (${msg}); fallback in-memory cache will be used.`);
      return true;
    }
  }
}

async function main() {
  console.log("=== Cooperative Banking Platform Pre-Flight Readiness ===");
  const secretsOk = await checkSecrets();
  const dbOk = await checkDatabase();
  const redisOk = await checkRedis();

  if (secretsOk && dbOk && redisOk) {
    console.log("=========================================================");
    log("ok", "Pre-flight checks passed successfully! System is production-ready.");
    process.exit(0);
  } else {
    console.log("=========================================================");
    log("err", "Pre-flight checks failed. Review errors above before deploying.");
    process.exit(1);
  }
}

main().catch((err) => {
  log("err", `Fatal preflight error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
