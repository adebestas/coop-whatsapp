/**
 * PERF-3: the indexes this migration adds must stay declared in BOTH Prisma
 * schemas (they back verified hot queries — a dropped @@index would silently
 * re-introduce a full table scan).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

describe("hot-path indexes", () => {
  it.each(["prisma/schema.prisma", "prisma/schema.local.prisma"])(
    "%s declares the hot-path indexes",
    (file) => {
      const schema = read(file);
      expect(schema).toContain("@@index([virtualAccountNumber])");
      expect(schema).toContain("@@index([memberId, createdAt])");
      expect(schema).toContain("@@index([entryId])");
    },
  );

  it("the migration creates the three indexes", () => {
    const sql = read("prisma/migrations/20261055000000_hot_path_indexes/migration.sql");
    expect(sql).toContain('CREATE INDEX "Member_virtualAccountNumber_idx"');
    expect(sql).toContain('CREATE INDEX "Payout_memberId_createdAt_idx"');
    expect(sql).toContain('CREATE INDEX "Posting_entryId_idx"');
  });
});
