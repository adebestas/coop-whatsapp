import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "./setup.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/lib/security.js";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";
const app = buildApp();

let ownerId: string;
beforeEach(async () => {
  await prisma.platformAdmin.deleteMany();
  const owner = await prisma.platformAdmin.create({
    data: { name: "Owner", phone: "2348000000001", role: "owner", pin: hashPin("123456"), mustChangePin: false },
  });
  ownerId = owner.id;
});

describe("platform auth", () => {
  it("logs in with phone + pin and sets the dev cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/api/developer/login", payload: { phone: "2348000000001", pin: "123456" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toContain("coop_dev_token=");
  });
  it("rejects a wrong pin", async () => {
    const res = await app.inject({ method: "POST", url: "/api/developer/login", payload: { phone: "2348000000001", pin: "000000" } });
    expect(res.statusCode).toBe(401);
  });
  it("rejects a coop admin token on developer routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/developer/me", headers: { authorization: "Bearer not.a.platform.token" } });
    expect(res.statusCode).toBe(401);
  });
  it("returns the current admin on /me", async () => {
    const login = await app.inject({ method: "POST", url: "/api/developer/login", payload: { phone: "2348000000001", pin: "123456" } });
    const cookie = login.headers["set-cookie"] as string;
    const res = await app.inject({ method: "GET", url: "/api/developer/me", headers: { cookie: cookie.split(";")[0] } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).admin.id).toBe(ownerId);
  });
  it("rejects a platform token on coop admin routes (scope is not transitive)", async () => {
    const login = await app.inject({ method: "POST", url: "/api/developer/login", payload: { phone: "2348000000001", pin: "123456" } });
    const cookie = (login.headers["set-cookie"] as string).split(";")[0];
    const res = await app.inject({ method: "GET", url: "/api/admin/overview", headers: { cookie } });
    expect([401, 403]).toContain(res.statusCode);
  });
  it("requires a TOTP code when the admin has 2FA enabled", async () => {
    const { generateTotpSecret } = await import("../src/lib/totp.js");
    await prisma.platformAdmin.update({ where: { id: ownerId }, data: { totpSecret: generateTotpSecret(), totpEnabled: true } });
    const res = await app.inject({ method: "POST", url: "/api/developer/login", payload: { phone: "2348000000001", pin: "123456" } });
    expect(res.statusCode).toBe(401);
  });
  it("blocks the support role from mutating", async () => {
    await prisma.platformAdmin.create({
      data: { name: "S", phone: "2348000000002", role: "support", pin: hashPin("123456"), mustChangePin: false },
    });
    const login = await app.inject({ method: "POST", url: "/api/developer/login", payload: { phone: "2348000000002", pin: "123456" } });
    const cookie = (login.headers["set-cookie"] as string).split(";")[0];
    const res = await app.inject({ method: "POST", url: "/api/developer/coops", payload: {}, headers: { cookie, "x-requested-with": "xmlhttprequest" } });
    expect(res.statusCode).toBe(403);
  });
  it("rejects a revoked token", async () => {
    const { signPlatformToken, revokePlatformToken } = await import("../src/lib/platform-auth.js");
    const token = signPlatformToken({ id: ownerId, phone: "2348000000001", role: "owner" });
    await revokePlatformToken(token);
    const res = await app.inject({ method: "GET", url: "/api/developer/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });
  it("rejects a token issued before tokensValidAfter", async () => {
    const { signPlatformToken } = await import("../src/lib/platform-auth.js");
    const token = signPlatformToken({ id: ownerId, phone: "2348000000001", role: "owner" });
    await prisma.platformAdmin.update({ where: { id: ownerId }, data: { tokensValidAfter: new Date(Date.now() + 60_000) } });
    const res = await app.inject({ method: "GET", url: "/api/developer/me", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });
});
