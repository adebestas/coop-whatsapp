/**
 * Finding 5: export retention. Generated exports carry member PII, and nothing
 * ever removed old files: pruneExports() had no caller and, even when called,
 * deleted Redis *keys* built from filenames rather than the files themselves,
 * while nothing ever wrote to `exports:list`.
 *
 * Retention is therefore directory-based: the newest N files win, and files
 * created moments ago are never unlinked (they may still be downloading).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
let dir: string;

async function makeDir() {
  dir = await mkdtemp(join(tmpdir(), "coop-exports-"));
  dirs.push(dir);
  process.env.EXPORT_DIR = dir;
  return dir;
}

async function seed(name: string, ageMs: number) {
  const path = join(dir, name);
  await writeFile(path, "x");
  const stamp = (Date.now() - ageMs) / 1000;
  await utimes(path, stamp, stamp);
}

async function loadPrune() {
  vi.resetModules();
  const mod = await import("../src/routes/exports.js");
  return mod.pruneExports;
}

describe("export retention", () => {
  beforeEach(async () => {
    await makeDir();
  });

  afterAll(async () => {
    delete process.env.EXPORT_DIR;
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  it("deletes the oldest export files beyond the retention limit", async () => {
    const hour = 60 * 60 * 1000;
    for (let i = 0; i < 17; i++) {
      await seed(`coop1-members-00000000000000${String(i).padStart(2, "0")}.xlsx`, (17 - i) * hour);
    }

    const pruneExports = await loadPrune();
    await pruneExports(14);

    const left = (await readdir(dir)).sort();
    expect(left).toHaveLength(14);
    expect(left).not.toContain("coop1-members-0000000000000000.xlsx");
    expect(left).not.toContain("coop1-members-0000000000000001.xlsx");
    expect(left).not.toContain("coop1-members-0000000000000002.xlsx");
    expect(left).toContain("coop1-members-0000000000000016.xlsx");
  });

  it("never unlinks a file created in the last minute", async () => {
    const hour = 60 * 60 * 1000;
    for (let i = 0; i < 15; i++) {
      await seed(`coop1-transactions-00000000000000${String(i).padStart(2, "0")}.xlsx`, (15 - i) * hour);
    }
    const fresh = "coop1-pnl-ffffffffffffffff.pdf";
    await seed(fresh, 0);

    const pruneExports = await loadPrune();
    await pruneExports(14);

    const left = await readdir(dir);
    expect(left).toContain(fresh);
    const old = left.filter((f) => f !== fresh);
    expect(old).toHaveLength(14);
    expect(old).not.toContain("coop1-transactions-0000000000000000.xlsx");
  });

  it("ignores files that are not exports and a missing directory", async () => {
    await seed(".env", 2 * 60 * 60 * 1000);
    await seed("notes.txt", 2 * 60 * 60 * 1000);
    await seed("coop1-members-aaaaaaaaaaaaaaaa.xlsx", 2 * 60 * 60 * 1000);

    const pruneExports = await loadPrune();
    await pruneExports(1);
    const left = await readdir(dir);
    expect(left).toContain(".env");
    expect(left).toContain("notes.txt");

    process.env.EXPORT_DIR = join(dir, "does-not-exist");
    const pruneMissing = await loadPrune();
    await expect(pruneMissing(1)).resolves.toBeUndefined();
  });
});
