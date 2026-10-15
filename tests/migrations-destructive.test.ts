/**
 * A14: migrations must not silently destroy populated columns/tables.
 *
 * The production database was created with `prisma db push`, so the first
 * `migrate deploy` runs against a populated DB. A bare
 * `ALTER TABLE ... DROP COLUMN` (or `DROP TABLE`) would irreversibly delete
 * real data with no warning. Destructive changes must be guarded (conditional
 * drop with an archive/quarantine step). This test fails on an unguarded
 * destructive statement anywhere in the migration history.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(repoRoot, "prisma", "migrations");

function migrationFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...migrationFiles(full));
    else if (entry.name.endsWith(".sql")) out.push(full);
  }
  return out;
}

describe("migration safety", () => {
  it("has no unguarded destructive DDL (bare DROP COLUMN / DROP TABLE)", () => {
    const offenders: string[] = [];
    for (const file of migrationFiles(migrationsDir)) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        // Ignore commented lines. A bare (top-level) DROP COLUMN/TABLE deletes
        // data unconditionally; guarded ones live inside a DO block and start
        // with EXECUTE, so they are not matched here.
        if (/^\s*--/.test(line)) return;
        if (
          /^\s*ALTER\s+TABLE\b.*\bDROP\s+COLUMN\b/i.test(line) ||
          /^\s*DROP\s+TABLE\b/i.test(line)
        ) {
          offenders.push(`${path.relative(repoRoot, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("archives and quarantines the previously-dropped populated columns", () => {
    const sql = readFileSync(
      path.join(migrationsDir, "20261002000000_loan_stages_account_officers", "migration.sql"),
      "utf8",
    );
    // Both columns are archived, then only renamed (not dropped) when populated.
    expect(sql).toMatch(/_backup_Member_tier/);
    expect(sql).toMatch(/RENAME COLUMN "tier" TO "tier_deprecated"/);
    expect(sql).toMatch(/_backup_LedgerEntry_status/);
    expect(sql).toMatch(/RENAME COLUMN "status" TO "status_deprecated"/);
  });
});
