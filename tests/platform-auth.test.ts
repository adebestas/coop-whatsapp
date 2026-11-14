import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./setup.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/lib/security.js";
import { resetRateLimit } from "../src/lib/cache.js";
import { ensurePlatformOwner } from "../src/services/platform-bootstrap.js";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";
const app = buildApp();

let ownerId: string;
beforeEach(async () => {
  await prisma.platformAdmin.deleteMany();
  await prisma.platformAuditLog.deleteMany();
  // Login no longer resets the shared per-IP limiter on success (that let any one
  // valid account keep the bucket at zero). Isolate each case explicitly instead.
  await resetRateLimit("devlogin:127.0.0.1");
  await resetRateLimit("devacct:2348000000001");
  await resetRateLimit("devacct:2348000000002");
  await resetRateLimit("devacct:2348000000003");
  await resetRateLimit("devacct:2348000000004");
  const owner = await prisma.platformAdmin.create({
    data: {
      name: "Owner",
      phone: "2348000000001",
      role: "owner",
      pin: hashPin("123456"),
      mustChangePin: false,
    },
  });
  ownerId = owner.id;
});

describe("platform auth", () => {
  it("logs in with phone + pin and sets the dev cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/developer/login",
      payload: { phone: "2348000000001", pin: "123456" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toContain("coop_dev_token=");
  });
  it("rejects a wrong pin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/developer/login",
      payload: { phone: "2348000000001", pin: "000000" },
    });
    expect(res.statusCode).toBe(401);
  });
  it("rejects a coop admin token on developer routes", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/developer/me",
      headers: { authorization: "Bearer not.a.platform.token" },
    });
    expect(res.statusCode).toBe(401);
  });
  it("returns the current admin on /me", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/developer/login",
      payload: { phone: "2348000000001", pin: "123456" },
    });
    const cookie = login.headers["set-cookie"] as string;
    const res = await app.inject({
      method: "GET",
      url: "/api/developer/me",
      headers: { cookie: cookie.split(";")[0] },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).admin.id).toBe(ownerId);
  });
  it("rejects a platform token on coop admin routes (scope is not transitive)", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/developer/login",
      payload: { phone: "2348000000001", pin: "123456" },
    });
    const cookie = (login.headers["set-cookie"] as string).split(";")[0];
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/overview",
      headers: { cookie },
    });
    expect([401, 403]).toContain(res.statusCode);
  });
  it("rejects a platform bearer token on coop admin routes with 401 (not 500)", async () => {
    const { signPlatformToken } = await import("../src/lib/platform-auth.js");
    const token = signPlatformToken({ id: ownerId, phone: "2348000000001", role: "owner" });
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/overview",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
  it("requires a TOTP code when the admin has 2FA enabled", async () => {
    const { generateTotpSecret } = await import("../src/lib/totp.js");
    await prisma.platformAdmin.update({
      where: { id: ownerId },
      data: { totpSecret: generateTotpSecret(), totpEnabled: true },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/developer/login",
      payload: { phone: "2348000000001", pin: "123456" },
    });
    expect(res.statusCode).toBe(401);
  });
  it("confines a must-change-pin admin to change-pin / me / logout", async () => {
    await prisma.platformAdmin.update({
      where: { id: ownerId },
      data: { mustChangePin: true },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/developer/login",
      payload: { phone: "2348000000001", pin: "123456" },
    });
    expect(login.statusCode).toBe(200);
    expect(JSON.parse(login.body).mustChangePin).toBe(true);
    const cookie = (login.headers["set-cookie"] as string).split(";")[0];
    const mutate = { cookie, "x-requested-with": "xmlhttprequest" };

    const blockedRefresh = await app.inject({
      method: "POST",
      url: "/api/developer/refresh",
      payload: {},
      headers: mutate,
    });
    expect(blockedRefresh.statusCode).toBe(403);
    expect(JSON.parse(blockedRefresh.body).error).toBe("pin_change_required");

    const blockedSetup = await app.inject({
      method: "POST",
      url: "/api/developer/setup-2fa",
      payload: { secret: "JBSWY3DPEHPK3PXP", code: "000000" },
      headers: mutate,
    });
    expect(blockedSetup.statusCode).toBe(403);

    const me = await app.inject({
      method: "GET",
      url: "/api/developer/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);

    const changed = await app.inject({
      method: "POST",
      url: "/api/developer/change-pin",
      payload: { currentPin: "123456", newPin: "654321" },
      headers: mutate,
    });
    expect(changed.statusCode).toBe(200);

    const noToken = await app.inject({
      method: "POST",
      url: "/api/developer/login",
      payload: { phone: "2348000000001", pin: "123456" },
    });
    expect(JSON.parse(noToken.body).token).toBeUndefined();
  });

  it("confines an owner without 2FA to enrolment", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/developer/login",
      payload: { phone: "2348000000001", pin: "123456" },
    });
    expect(login.statusCode).toBe(200);
    expect(JSON.parse(login.body).mustSetup2fa).toBe(true);
    const cookie = (login.headers["set-cookie"] as string).split(";")[0];

    const blocked = await app.inject({
      method: "GET",
      url: "/api/developer/coops",
      headers: { cookie },
    });
    expect(blocked.statusCode).toBe(403);
    expect(JSON.parse(blocked.body).error).toBe("two_factor_setup_required");

    const { generateTotpSecret, totpAt } = await import("../src/lib/totp.js");
    const secret = generateTotpSecret();
    const missingPin = await app.inject({
      method: "POST",
      url: "/api/developer/setup-2fa",
      payload: { secret, code: totpAt(secret) },
      headers: { cookie, "x-requested-with": "xmlhttprequest" },
    });
    expect(missingPin.statusCode).toBe(400);

    const wrongPin = await app.inject({
      method: "POST",
      url: "/api/developer/setup-2fa",
      payload: { secret, code: totpAt(secret), currentPin: "000000" },
      headers: { cookie, "x-requested-with": "xmlhttprequest" },
    });
    expect(wrongPin.statusCode).toBe(401);

    const enrolled = await app.inject({
      method: "POST",
      url: "/api/developer/setup-2fa",
      payload: { secret, code: totpAt(secret), currentPin: "123456" },
      headers: { cookie, "x-requested-with": "xmlhttprequest" },
    });
    expect(enrolled.statusCode).toBe(200);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/developer/coops",
      headers: { cookie },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("requires the current PIN to change the PIN and revokes old sessions", async () => {
    await prisma.platformAdmin.update({
      where: { id: ownerId },
      data: { mustChangePin: true },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/developer/login",
      payload: { phone: "2348000000001", pin: "123456" },
    });
    const oldCookie = (login.headers["set-cookie"] as string).split(";")[0];
    const mutate = { cookie: oldCookie, "x-requested-with": "xmlhttprequest" };

    const missing = await app.inject({
      method: "POST",
      url: "/api/developer/change-pin",
      payload: { newPin: "654321" },
      headers: mutate,
    });
    expect(missing.statusCode).toBe(400);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/developer/change-pin",
      payload: { currentPin: "000000", newPin: "654321" },
      headers: mutate,
    });
    expect(wrong.statusCode).toBe(401);

    const changed = await app.inject({
      method: "POST",
      url: "/api/developer/change-pin",
      payload: { currentPin: "123456", newPin: "654321" },
      headers: mutate,
    });
    expect(changed.statusCode).toBe(200);
    const newCookie = (changed.headers["set-cookie"] as string).split(";")[0];
    expect(newCookie).not.toBe(oldCookie);

    const stale = await app.inject({
      method: "GET",
      url: "/api/developer/me",
      headers: { cookie: oldCookie },
    });
    expect(stale.statusCode).toBe(401);

    const fresh = await app.inject({
      method: "GET",
      url: "/api/developer/me",
      headers: { cookie: newCookie },
    });
    expect(fresh.statusCode).toBe(200);
  });

  it("revokes the previous token when refreshing", async () => {
    await prisma.platformAdmin.create({
      data: {
        name: "S",
        phone: "2348000000003",
        role: "support",
        pin: hashPin("123456"),
        mustChangePin: false,
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/developer/login",
      payload: { phone: "2348000000003", pin: "123456" },
    });
    const oldCookie = (login.headers["set-cookie"] as string).split(";")[0];
    const refresh = await app.inject({
      method: "POST",
      url: "/api/developer/refresh",
      headers: { cookie: oldCookie, "x-requested-with": "xmlhttprequest" },
    });
    expect(refresh.statusCode).toBe(200);
    const newCookie = (refresh.headers["set-cookie"] as string).split(";")[0];

    const stale = await app.inject({
      method: "GET",
      url: "/api/developer/me",
      headers: { cookie: oldCookie },
    });
    expect(stale.statusCode).toBe(401);

    const fresh = await app.inject({
      method: "GET",
      url: "/api/developer/me",
      headers: { cookie: newCookie },
    });
    expect(fresh.statusCode).toBe(200);
  });

  it("writes auth events to the platform audit log", async () => {
    await app.inject({
      method: "POST",
      url: "/api/developer/login",
      payload: { phone: "2348000000001", pin: "000000" },
    });
    expect(
      await prisma.platformAuditLog.count({ where: { action: "auth.login_failed" } }),
    ).toBeGreaterThan(0);

    await app.inject({
      method: "POST",
      url: "/api/developer/login",
      payload: { phone: "2348000000001", pin: "123456" },
    });
    expect(
      await prisma.platformAuditLog.count({ where: { action: "auth.login_success" } }),
    ).toBeGreaterThan(0);
  });

  it("lets an owner reset another admin's 2FA with step-up auth", async () => {
    const { generateTotpSecret, totpAt } = await import("../src/lib/totp.js");
    const ownerSecret = generateTotpSecret();
    await prisma.platformAdmin.update({
      where: { id: ownerId },
      data: { totpSecret: ownerSecret, totpEnabled: true },
    });
    const target = await prisma.platformAdmin.create({
      data: {
        name: "Dev",
        phone: "2348000000004",
        role: "developer",
        pin: hashPin("123456"),
        mustChangePin: false,
        totpSecret: generateTotpSecret(),
        totpEnabled: true,
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/developer/login",
      payload: { phone: "2348000000001", pin: "123456", totp: totpAt(ownerSecret) },
    });
    expect(login.statusCode).toBe(200);
    const cookie = (login.headers["set-cookie"] as string).split(";")[0];

    const res = await app.inject({
      method: "POST",
      url: `/api/developer/admins/${target.id}/reset-2fa`,
      payload: { confirmPin: "123456", totp: totpAt(ownerSecret) },
      headers: { cookie, "x-requested-with": "xmlhttprequest" },
    });
    expect(res.statusCode).toBe(200);
    const updated = await prisma.platformAdmin.findUnique({ where: { id: target.id } });
    expect(updated?.totpEnabled).toBe(false);
    expect(updated?.totpSecret).toBeNull();
    expect(
      await prisma.platformAuditLog.count({ where: { action: "platform_admin.reset_2fa" } }),
    ).toBe(1);
  });
  it("blocks the support role from mutating", async () => {
    await prisma.platformAdmin.create({
      data: {
        name: "S",
        phone: "2348000000002",
        role: "support",
        pin: hashPin("123456"),
        mustChangePin: false,
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/developer/login",
      payload: { phone: "2348000000002", pin: "123456" },
    });
    const cookie = (login.headers["set-cookie"] as string).split(";")[0];
    const res = await app.inject({
      method: "POST",
      url: "/api/developer/coops",
      payload: {},
      headers: { cookie, "x-requested-with": "xmlhttprequest" },
    });
    expect(res.statusCode).toBe(403);
  });
  it("rejects a revoked token", async () => {
    const { signPlatformToken, revokePlatformToken } = await import("../src/lib/platform-auth.js");
    const token = signPlatformToken({ id: ownerId, phone: "2348000000001", role: "owner" });
    await revokePlatformToken(token);
    const res = await app.inject({
      method: "GET",
      url: "/api/developer/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
  it("rejects a token issued before tokensValidAfter", async () => {
    const { signPlatformToken } = await import("../src/lib/platform-auth.js");
    const token = signPlatformToken({ id: ownerId, phone: "2348000000001", role: "owner" });
    await prisma.platformAdmin.update({
      where: { id: ownerId },
      data: { tokensValidAfter: new Date(Date.now() + 60_000) },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/developer/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
  it("seeds the first owner from PLATFORM_OWNER_PHONE once", async () => {
    await prisma.platformAdmin.deleteMany();
    process.env.PLATFORM_OWNER_PHONE = "2348099999999";
    process.env.PLATFORM_OWNER_NAME = "Boss";
    try {
      await ensurePlatformOwner();
      await ensurePlatformOwner();
      const owners = await prisma.platformAdmin.findMany({ where: { role: "owner" } });
      expect(owners.length).toBe(1);
      expect(owners[0].phone).toBe("2348099999999");
      expect(owners[0].mustChangePin).toBe(true);
    } finally {
      delete process.env.PLATFORM_OWNER_PHONE;
      delete process.env.PLATFORM_OWNER_NAME;
    }
  });
});
