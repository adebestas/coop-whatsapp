/**
 * CSRF defense in depth: the admin cookie is SameSite=Strict, but a state
 * change from a foreign origin must still be refused even if a browser or proxy
 * misbehaves. Non-browser clients (Bearer tokens, provider webhooks) send no
 * Origin and are unaffected.
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

const payload = { phone: "2348000000000", pin: "1234" };

describe("cross-site request guard", () => {
  it("blocks a mutating admin request from a foreign origin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { origin: "https://evil.example" },
      payload,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "Cross-site request blocked" });
  });

  it("allows a same-host origin and requests without an Origin header", async () => {
    const sameHost = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { origin: "http://localhost:80" },
      payload,
    });
    expect(sameHost.statusCode).not.toBe(403);

    const noOrigin = await app.inject({ method: "POST", url: "/api/admin/login", payload });
    expect(noOrigin.statusCode).not.toBe(403);
  });
});
