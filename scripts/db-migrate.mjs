#!/usr/bin/env node
/**
 * Boot-time database migration with safe baselining.
 *
 * Why this exists: production (Neon Postgres) was originally created with
 * `prisma db push`, so it has all the tables but NO `_prisma_migrations`
 * history. A plain `prisma migrate deploy` on such a database tries to run
 * `0_init` again and dies on "relation already exists".
 *
 * Rules (deterministic, no guessing on a ledger):
 *   1. Fresh database (no application tables)      -> `migrate deploy` applies everything.
 *   2. Migration history already contains `0_init` -> `migrate deploy` applies only what is pending.
 *   3. Tables exist but `0_init` is not recorded    -> this is a `db push` database. We may ONLY mark
 *      `0_init` as applied if the live schema is byte-for-byte what `0_init` produces
 *      (verified with `prisma migrate diff --from-url ... --to-schema-datamodel <baseline>`).
 *      If the live schema differs, we refuse to boot and print the drift so a human decides.
 *      Set DB_BASELINE_FORCE=1 to skip the drift check (only after you have verified it yourself).
 *
 * Exit codes: 0 ok, 1 refused/failed.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const BASELINE_MIGRATION = "0_init";
const BASELINE_SCHEMA = path.join(root, "prisma", "baseline", "schema.47ef2f6.prisma");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function log(msg) {
  process.stdout.write(`[db-migrate] ${msg}\n`);
}

function prisma(args, { allowFail = false } = {}) {
  log(`prisma ${args.join(" ")}`);
  const res = spawnSync(npx, ["prisma", ...args], { cwd: root, stdio: "inherit", env: process.env, shell: process.platform === "win32" });
  if (res.status !== 0 && !allowFail) {
    log(`FAILED (exit ${res.status})`);
    process.exit(1);
  }
  return res.status ?? 1;
}

async function inspect() {
  const client = new PrismaClient({ log: [] });
  try {
    const tables = await client.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('Member', '_prisma_migrations')`,
    );
    const names = new Set(tables.map((t) => t.table_name));
    let baselineRecorded = false;
    if (names.has("_prisma_migrations")) {
      const rows = await client.$queryRawUnsafe(
        `SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL`,
        BASELINE_MIGRATION,
      );
      baselineRecorded = rows.length > 0;
    }
    return { hasAppTables: names.has("Member"), hasHistory: names.has("_prisma_migrations"), baselineRecorded };
  } finally {
    await client.$disconnect();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    log("DATABASE_URL is not set");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL.startsWith("postgres")) {
    log(`DATABASE_URL is not a PostgreSQL URL (${process.env.DATABASE_URL.split(":")[0]}:...). Refusing: production schema is PostgreSQL.`);
    process.exit(1);
  }

  const state = await inspect();
  log(`state: appTables=${state.hasAppTables} history=${state.hasHistory} baselineRecorded=${state.baselineRecorded}`);

  if (state.hasAppTables && !state.baselineRecorded) {
    log(`database has application tables but no '${BASELINE_MIGRATION}' record -> candidate for baselining`);
    if (process.env.DB_BASELINE_FORCE === "1") {
      log("DB_BASELINE_FORCE=1 set: skipping drift check");
    } else {
      if (!existsSync(BASELINE_SCHEMA)) {
        log(`baseline schema missing at ${BASELINE_SCHEMA}; cannot verify drift. Refusing to boot.`);
        process.exit(1);
      }
      // exit 0 = identical, 2 = differences, 1 = error
      const code = prisma(
        ["migrate", "diff", "--from-url", process.env.DATABASE_URL, "--to-schema-datamodel", BASELINE_SCHEMA, "--exit-code"],
        { allowFail: true },
      );
      if (code === 2) {
        log("REFUSING TO BOOT: live schema differs from the 0_init baseline (diff printed above).");
        log("Reconcile manually, then either fix the schema or re-run with DB_BASELINE_FORCE=1 once you have verified it.");
        process.exit(1);
      }
      if (code !== 0) {
        log(`drift check errored (exit ${code}); refusing to boot.`);
        process.exit(1);
      }
      log("live schema matches 0_init baseline");
    }
    prisma(["migrate", "resolve", "--applied", BASELINE_MIGRATION]);
  }

  prisma(["migrate", "deploy"]);
  log("done");
}

main().catch((err) => {
  log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
