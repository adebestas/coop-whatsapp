/**
 * PERF-2: backup verification must actually validate the ARTIFACT. The old
 * routine checksummed the LIVE database (it "restored" nothing), so it could
 * never detect a missing / truncated / corrupt backup.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findLatestBackup, verifyBackupFile } from "../src/services/backup-verify.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "coop-backup-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function artifact(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    exportedAt: "2026-10-16T00:00:00.000Z",
    version: 3,
    tables: {
      cooperatives: [{ id: "c1" }],
      members: [{ id: "m1" }],
      wallets: [{ id: "w1" }],
      ...overrides,
    },
  });
}

describe("verifyBackupFile", () => {
  it("accepts a well-formed artifact", async () => {
    const file = join(dir, "coop-backup-2026-10-16.json");
    await writeFile(file, artifact());
    const result = await verifyBackupFile(file);
    expect(result.ok).toBe(true);
    expect(result.tableCount).toBe(3);
    expect(result.totalRows).toBe(3);
  });

  it("rejects a truncated / invalid JSON file", async () => {
    const file = join(dir, "coop-backup-bad.json");
    await writeFile(file, '{"version":3,"tables":{"members":[{"id"');
    const result = await verifyBackupFile(file);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects an artifact that is missing required tables", async () => {
    const file = join(dir, "coop-backup-empty.json");
    await writeFile(file, JSON.stringify({ exportedAt: "x", version: 3, tables: { members: [] } }));
    const result = await verifyBackupFile(file);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/required tables/);
  });

  it("rejects an artifact whose critical tables are empty", async () => {
    const file = join(dir, "coop-backup-norecords.json");
    await writeFile(file, artifact({ members: [], wallets: [] }));
    const result = await verifyBackupFile(file);
    expect(result.ok).toBe(false);
    expect(result.emptyCriticalTables).toEqual(["members", "wallets"]);
  });

  it("rejects a wrong-version artifact", async () => {
    const file = join(dir, "coop-backup-v2.json");
    await writeFile(file, JSON.stringify({ version: 2, tables: {} }));
    const result = await verifyBackupFile(file);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/version/);
  });
});

describe("findLatestBackup", () => {
  it("returns the newest artifact and ignores unrelated files", async () => {
    await writeFile(join(dir, "coop-backup-2026-10-15.json"), artifact());
    await writeFile(join(dir, "coop-backup-2026-10-16.json"), artifact());
    await writeFile(join(dir, "notes.txt"), "x");
    const latest = await findLatestBackup(dir);
    expect(latest).toBe(join(dir, "coop-backup-2026-10-16.json"));
  });

  it("returns null when there is no artifact", async () => {
    expect(await findLatestBackup(dir)).toBeNull();
  });
});
