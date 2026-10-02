import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * prisma/schema.prisma (PostgreSQL, production) and prisma/schema.local.prisma
 * (SQLite, tests + local dev) must hold the SAME datamodel. Only the leading
 * comment block and the datasource provider may differ.
 *
 * This guard exists because the two files drifted silently once and the "fix"
 * was to flip the production schema to SQLite, which made `main` undeployable.
 */
function normalise(file: string): string {
  const raw = readFileSync(path.resolve(__dirname, "..", "prisma", file), "utf8");
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .map((line) => line.replace(/^\s*provider\s*=\s*"(postgresql|sqlite)"\s*$/, "  provider = <DB>"))
    .join("\n")
    .trim();
}

describe("prisma schema sync", () => {
  it("schema.prisma is PostgreSQL and schema.local.prisma is SQLite", () => {
    const prod = readFileSync(path.resolve(__dirname, "..", "prisma", "schema.prisma"), "utf8");
    const local = readFileSync(path.resolve(__dirname, "..", "prisma", "schema.local.prisma"), "utf8");
    expect(prod).toMatch(/datasource db \{[^}]*provider\s*=\s*"postgresql"/);
    expect(local).toMatch(/datasource db \{[^}]*provider\s*=\s*"sqlite"/);
  });

  it("both schemas carry an identical datamodel", () => {
    expect(normalise("schema.local.prisma")).toBe(normalise("schema.prisma"));
  });

  it("migration_lock.toml is PostgreSQL", () => {
    const lock = readFileSync(path.resolve(__dirname, "..", "prisma", "migrations", "migration_lock.toml"), "utf8");
    expect(lock).toMatch(/provider\s*=\s*"postgresql"/);
  });
});
