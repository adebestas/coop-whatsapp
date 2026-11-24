/**
 * Pre-deployment hardening guards from the 2026-11-23 security audit.
 *
 * Two invariants that a future change could silently break:
 *
 *   1. The runtime role can append to the audit tables but never rewrite or
 *      erase them. `coop_app` is granted UPDATE/DELETE on every table so normal
 *      business writes work, so the revokes live in the boot migration and in
 *      bootstrap.sh. If app code starts updating/deleting those rows it would
 *      fail at runtime, so the source scan below fails first.
 *   2. CSP violations have somewhere to go. The dashboard relies on
 *      `scriptSrcAttr: 'none'`; without a report endpoint a regression would be
 *      invisible.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("audit-table immutability", () => {
  const bootstrap = readFileSync(path.join(repoRoot, "deploy", "bootstrap.sh"), "utf8");
  const migrate = readFileSync(path.join(repoRoot, "scripts", "db-migrate.mjs"), "utf8");

  it("revokes write privileges on the audit tables after granting them", () => {
    const grantAt = bootstrap.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES");
    expect(grantAt).toBeGreaterThan(-1);
    for (const statement of [
      `REVOKE UPDATE, DELETE ON public."AuditLog" FROM coop_app`,
      `REVOKE UPDATE, DELETE ON public."LoginAttempt" FROM coop_app`,
      `REVOKE DELETE ON public."WebhookEvent" FROM coop_app`,
    ]) {
      const at = bootstrap.indexOf(statement);
      expect(at, statement).toBeGreaterThan(grantAt);
    }
  });

  it("re-applies the revokes after every boot-time migration", () => {
    const migrateAt = migrate.indexOf(`prisma(["migrate", "deploy"])`);
    const hardenAt = migrate.lastIndexOf("await hardenAuditTables()");
    expect(migrateAt).toBeGreaterThan(-1);
    expect(hardenAt).toBeGreaterThan(migrateAt);
    for (const statement of [
      `REVOKE UPDATE, DELETE ON public."AuditLog" FROM coop_app`,
      `REVOKE UPDATE, DELETE ON public."LoginAttempt" FROM coop_app`,
      `REVOKE DELETE ON public."WebhookEvent" FROM coop_app`,
    ]) {
      expect(migrate).toContain(statement);
    }
  });

  it("has no application code that rewrites or erases audit records", () => {
    const forbidden = [
      /auditLog\.(update|updateMany|upsert|delete|deleteMany)\b/,
      /loginAttempt\.(update|updateMany|upsert|delete|deleteMany)\b/,
      /webhookEvent\.(delete|deleteMany)\b/,
      /DELETE\s+FROM\s+"?(AuditLog|LoginAttempt|WebhookEvent)"?/i,
      /UPDATE\s+"?(AuditLog|LoginAttempt)"?\s+SET/i,
      /TRUNCATE\s+"?(AuditLog|LoginAttempt|WebhookEvent)"?/i,
    ];
    const offenders: string[] = [];
    for (const file of walk(path.join(repoRoot, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(source)) offenders.push(`${path.relative(repoRoot, file)}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("CSP violation reporting", () => {
  let app: ReturnType<typeof buildApp>;

  afterEach(async () => {
    await app?.close();
  });

  async function post(body: string, contentType: string) {
    app = buildApp();
    await app.ready();
    return app.inject({
      method: "POST",
      url: "/api/csp-report",
      headers: { "content-type": contentType },
      payload: body,
    });
  }

  it("advertises a report endpoint in the CSP", async () => {
    app = buildApp();
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.headers["content-security-policy"]).toContain("report-uri /api/csp-report");
  });

  it("accepts a legacy csp-report body without echoing it", async () => {
    const res = await post(
      JSON.stringify({
        "csp-report": {
          "effective-directive": "script-src-attr",
          "blocked-uri": "inline",
          "document-uri": "https://example.test/dashboard/",
        },
      }),
      "application/csp-report",
    );
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");
  });

  it("accepts a Reporting API batch", async () => {
    const res = await post(
      JSON.stringify([{ type: "csp-violation", body: { blockedURL: "inline" } }]),
      "application/reports+json",
    );
    expect(res.statusCode).toBe(204);
  });

  it("does not fail on a malformed report", async () => {
    const res = await post("{not json", "application/csp-report");
    expect(res.statusCode).toBe(204);
  });
});
