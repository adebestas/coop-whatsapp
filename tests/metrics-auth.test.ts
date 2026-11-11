/**
 * SEC-P1: /metrics leaks request volumes, job names and process internals. In
 * production it must not be public by default: no METRICS_TOKEN means the
 * endpoint is not served, and a configured token is enforced.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";

async function appFor(test: (app: ReturnType<typeof buildApp>) => Promise<void>) {
  const app = buildApp();
  await app.ready();
  try {
    await test(app);
  } finally {
    await app.close();
  }
}

const secureHeaders = { "x-forwarded-proto": "https" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/metrics exposure", () => {
  it("is not served in production without METRICS_TOKEN", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("METRICS_TOKEN", "");
    await appFor(async (app) => {
      const res = await app.inject({ method: "GET", url: "/metrics", headers: secureHeaders });
      expect(res.statusCode).toBe(404);
    });
  });

  it("requires the bearer token when METRICS_TOKEN is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("METRICS_TOKEN", "metrics-secret");
    await appFor(async (app) => {
      const denied = await app.inject({ method: "GET", url: "/metrics", headers: secureHeaders });
      expect(denied.statusCode).toBe(401);

      const allowed = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: { ...secureHeaders, authorization: "Bearer metrics-secret" },
      });
      expect(allowed.statusCode).toBe(200);
    });
  });
});
