/**
 * A13: the render.yaml blueprint must actually run migrations on deploy.
 *
 * `runtime: node` uses native `buildCommand`/`startCommand` (never the
 * Dockerfile CMD), so the boot-time migration in the Dockerfile is dead code.
 * Migrations therefore have to be wired as a `preDeployCommand`, which Render
 * runs once per deploy before the new version receives traffic. This test
 * guards that wiring against silent removal.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const renderYaml = readFileSync(path.join(repoRoot, "render.yaml"), "utf8");

/** Split the blueprint into one string per `- type: web` service entry. */
function webServiceBlocks(source: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*-\s+type:\s*web\s*$/.test(line)) {
      if (current) blocks.push(current.join("\n"));
      current = [line];
    } else if (current && /^\s*-\s+(type|name):/.test(line)) {
      // A new top-level service/database entry ends the current web block.
      blocks.push(current.join("\n"));
      current = null;
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current.join("\n"));
  return blocks;
}

describe("docker build context", () => {
  it("excludes the local dev database, dumps, local exports and the bootstrap PIN", () => {
    const ignored = readFileSync(path.join(repoRoot, ".dockerignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    // `COPY prisma ./prisma/` in the production stage would otherwise bake the
    // laptop SQLite database (member phone numbers + PIN hashes) into the image.
    for (const entry of [
      "prisma/dev.db",
      "prisma/*.db*",
      "platform-owner-pin.txt",
      "baseline.sql",
      "backups/",
      "exports/",
      "test-*.txt",
    ]) {
      expect(ignored).toContain(entry);
    }
  });
});

describe("render.yaml deployment wiring", () => {
  it("wires the migration pre-deploy command on every web service", () => {
    const blocks = webServiceBlocks(renderYaml);
    expect(blocks.length).toBeGreaterThanOrEqual(2); // staging + production

    for (const block of blocks) {
      // Native runtime — the Dockerfile is not used, so migrations must be a
      // pre-deploy command rather than relying on the image CMD.
      expect(block).toMatch(/runtime:\s*node/);
      expect(block).toMatch(/preDeployCommand:\s*node scripts\/db-migrate\.mjs/);
    }
  });
});
