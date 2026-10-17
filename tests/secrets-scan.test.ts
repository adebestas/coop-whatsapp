/**
 * SEC-6: no high-signal secrets may be committed.
 *
 * Scans git-TRACKED files (what would actually be pushed) for credential
 * patterns, and asserts `.env` stays untracked. The real local `.env` is
 * gitignored, so it is intentionally not scanned here — this guards against a
 * secret being added to a tracked file in the future.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "Neon password", re: /npg_[A-Za-z0-9]{8,}/ },
  { name: "Neon endpoint host", re: /ep-[a-z]+-[a-z]+-[a-z0-9]+\.(?:[a-z0-9-]+\.)*neon\.tech/ },
  { name: "Stripe-style live secret", re: /sk_live_[A-Za-z0-9]{10,}/ },
  { name: "Groq API key", re: /gsk_[A-Za-z0-9]{20,}/ },
  { name: "AWS access key id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function readIfText(rel: string): string | null {
  try {
    const buf = readFileSync(path.join(repoRoot, rel));
    return buf.subarray(0, 8000).includes(0) ? null : buf.toString("utf8");
  } catch {
    return null;
  }
}

describe("secret scan", () => {
  it("has no high-signal secrets in tracked files", () => {
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      if (file === "package-lock.json") continue;
      const text = readIfText(file);
      if (text === null) continue;
      for (const { name, re } of PATTERNS) {
        if (re.test(text)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps .env untracked (gitignored)", () => {
    let tracked = true;
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", ".env"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
    } catch {
      tracked = false;
    }
    expect(tracked).toBe(false);
  });
});
