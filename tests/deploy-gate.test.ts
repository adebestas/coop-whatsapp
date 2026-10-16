import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * OPS-7: the deploy gates must be real, not cosmetic. Render used to
 * `autoDeploy: true`, so every push shipped regardless of CI and the CI
 * "deploy gate" jobs only printed a message. The repo now relies on CI to
 * trigger the deploy (Render Deploy Hook) after all checks pass; these guards
 * fail loudly if anyone re-enables push-to-deploy or guts the gate.
 */
const root = path.resolve(__dirname, "..");
const renderYaml = readFileSync(path.join(root, "render.yaml"), "utf8");
const ciYaml = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

function jobBlock(name: string): string {
  const start = ciYaml.indexOf(`\n  ${name}:`);
  expect(start, `job "${name}" not found in ci.yml`).toBeGreaterThan(-1);
  const rest = ciYaml.slice(start + 1);
  const next = rest.search(/\n  [a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("deploy gating", () => {
  it("render.yaml does not auto-deploy on push", () => {
    expect(renderYaml).not.toMatch(/autoDeploy:\s*true/);
    // Both web services (staging + production) must explicitly disable it.
    expect(renderYaml.match(/autoDeploy:\s*false/g) ?? []).toHaveLength(2);
  });

  it.each([
    ["staging-deploy-gate", "RENDER_DEPLOY_HOOK_STAGING"],
    ["production-deploy-gate", "RENDER_DEPLOY_HOOK_PRODUCTION"],
  ])("%s waits for all checks then triggers the Render deploy", (job, secret) => {
    const block = jobBlock(job);
    expect(block).toMatch(/needs:[\s\S]*typecheck-and-lint/);
    expect(block).toMatch(/needs:[\s\S]*unit-tests/);
    expect(block).toMatch(/needs:[\s\S]*security-tests/);
    expect(block).toMatch(/needs:[\s\S]*postgres-migrations/);
    expect(block).toMatch(/needs:[\s\S]*build/);
    // Actually deploys (POST the hook) rather than merely echoing a message.
    expect(block).toContain(secret);
    expect(block).toMatch(/curl\s+-\S*\s*-X\s+POST/);
  });
});
