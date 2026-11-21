import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createTestApp } from "./setup.js";

describe("edge hardening", () => {
  const apps: Awaited<ReturnType<typeof createTestApp>>[] = [];

  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
  });

  it("does not advertise the framework or runtime on responses", async () => {
    const app = await createTestApp();
    apps.push(app);
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers.server).toBeUndefined();
  });

  it("tracks only the allowlisted env files", () => {
    const out = execFileSync("git", ["ls-files"], { encoding: "utf8" });
    const envFiles = out
      .split(/\r?\n/)
      .filter((f) => f.length > 0 && /(^|\/)\.env/.test(f))
      .sort();
    expect(envFiles).toEqual([".env.example", "deploy/.env.example"]);
  });

  it("keeps the Caddyfile rejecting dotfiles and stripping identifying headers", async () => {
    const { readFile } = await import("node:fs/promises");
    const caddy = await readFile(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
    expect(caddy).toMatch(/@dotfiles path .*\.env\*/);
    expect(caddy).toMatch(/respond @dotfiles 404/);
    expect(caddy).toMatch(/header -X-Powered-By/);
    expect(caddy).toMatch(/header_down -Server/);
    expect(caddy).toContain("Strict-Transport-Security");
  });
});
