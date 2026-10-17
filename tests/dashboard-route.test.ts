/**
 * OPS-6: the admin dashboard must be served outside the Docker image too. The
 * static root used to be hardcoded to `/app/dashboard` (a container-only path),
 * so every non-container deploy silently served no dashboard.
 */
import { afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { createTestApp, closeTestApp } from "./setup.js";
import { resolveDashboardDir } from "../src/app.js";

describe("admin dashboard static serving", () => {
  afterAll(async () => {
    await closeTestApp();
  });

  it("resolves the dashboard directory that ships with the app", () => {
    const dir = resolveDashboardDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, "index.html"))).toBe(true);
  });

  it("honours DASHBOARD_DIR when set", () => {
    const prev = process.env.DASHBOARD_DIR;
    process.env.DASHBOARD_DIR = path.resolve("/tmp/custom-dash");
    try {
      expect(resolveDashboardDir()).toBe(path.resolve("/tmp/custom-dash"));
    } finally {
      if (prev === undefined) delete process.env.DASHBOARD_DIR;
      else process.env.DASHBOARD_DIR = prev;
    }
  });

  it("serves the dashboard over HTTP at /dashboard/", async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/dashboard/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<html/i);
  });

  it("redirects /dashboard to /dashboard/", async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/dashboard/");
  });
});
