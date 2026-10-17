#!/usr/bin/env node
/**
 * Generate the Prisma client for whichever database the current environment uses.
 *
 *   DATABASE_URL=file:...        -> prisma/schema.local.prisma  (SQLite; local dev + `npm test`)
 *   DATABASE_URL=postgres://...  -> prisma/schema.prisma        (PostgreSQL; production)
 *
 * Pass `--local` or `--prod` to force one. `npm test` always forces --local.
 *
 * Background: both schema files MUST hold the same datamodel (tests/schema-sync.test.ts
 * enforces it). Only the datasource provider differs. The generated client is
 * provider-specific, so it has to be regenerated when switching databases.
 */
import { spawnSync } from "node:child_process";
import { config as dotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv({ path: path.join(root, ".env") });

const arg = process.argv[2];
let useLocal;
if (arg === "--local") useLocal = true;
else if (arg === "--prod") useLocal = false;
else useLocal = (process.env.DATABASE_URL ?? "").startsWith("file:");

const schema = useLocal ? "prisma/schema.local.prisma" : "prisma/schema.prisma";
process.stdout.write(`[prisma-generate] ${useLocal ? "SQLite (local)" : "PostgreSQL (prod)"} -> ${schema}\n`);

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const res = spawnSync(npx, ["prisma", "generate", "--schema", schema], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(res.status ?? 1);
