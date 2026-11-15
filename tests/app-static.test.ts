/**
 * Dashboard delivery: compress text responses and let browsers cache static
 * assets instead of re-downloading the bundle on every navigation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./setup.js";

let app: Awaited<ReturnType<typeof createTestApp>>;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

describe("dashboard delivery", () => {
  it("gzips the dashboard script when the client advertises gzip", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/app.js",
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-encoding"])).toContain("gzip");
  });

  it("caches JS/CSS for an hour but never the HTML shell", async () => {
    const js = await app.inject({ method: "GET", url: "/dashboard/app.js" });
    expect(String(js.headers["cache-control"])).toContain("max-age=3600");

    const html = await app.inject({ method: "GET", url: "/dashboard/" });
    expect(String(html.headers["cache-control"])).toContain("no-cache");
  });
});
