/**
 * SEC-7: CI / supply-chain hardening guards.
 *
 * Keeps the workflow's supply-chain posture from silently regressing: every
 * GitHub Action must be pinned to a full commit SHA, production dependencies
 * must be audited, and Dependabot must cover both npm and github-actions.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ci = readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
const dependabot = readFileSync(path.join(repoRoot, ".github", "dependabot.yml"), "utf8");

describe("CI hardening", () => {
  it("pins every GitHub Action to a full commit SHA", () => {
    const usesLines = ci.split(/\r?\n/).filter((l) => /^\s*uses:/.test(l));
    expect(usesLines.length).toBeGreaterThan(0);
    for (const line of usesLines) {
      expect(line).toMatch(/uses:\s+[^@\s]+@[0-9a-f]{40}(\s|#|$)/);
    }
  });

  it("runs a production dependency audit", () => {
    expect(ci).toMatch(/npm audit --omit=dev --audit-level=high/);
  });

  it("configures Dependabot for npm and github-actions", () => {
    expect(dependabot).toMatch(/package-ecosystem:\s*"npm"/);
    expect(dependabot).toMatch(/package-ecosystem:\s*"github-actions"/);
  });
});
