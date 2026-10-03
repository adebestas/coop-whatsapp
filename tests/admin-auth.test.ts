import { describe, expect, it } from "vitest";
import { createTestApp, createTestCoop, createTestMember } from "./setup.js";
import { verifyAdminToken, TOKEN_TTL_MS } from "../src/lib/admin-auth.js";

describe("admin token lifetime + refresh", () => {
  it("issues a short-lived access token", () => {
    expect(TOKEN_TTL_MS).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
  });

  it("refreshes a valid token and the new token works on a protected route", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("ADMREF");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348090000300",
      pin: "1234",
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { phone: admin.phone, pin: "1234" },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;
    expect(token).toBeTruthy();

    const refresh = await app.inject({
      method: "POST",
      url: "/api/admin/refresh",
      headers: { authorization: `Bearer ${token}`, "x-requested-with": "XMLHttpRequest" },
    });
    expect(refresh.statusCode).toBe(200);
    const newToken = refresh.json().token as string;
    expect(newToken).toBeTruthy();
    expect(verifyAdminToken(newToken)?.cooperativeId).toBe(coop.id);

    const overview = await app.inject({
      method: "GET",
      url: "/api/admin/overview",
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(overview.statusCode).toBe(200);
  });

  it("rejects refresh without a token", async () => {
    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/refresh",
      headers: { "x-requested-with": "XMLHttpRequest" },
    });
    expect(res.statusCode).toBe(401);
  });
});
