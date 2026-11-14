/**
 * SEC: admins who have enrolled an authenticator must present a live TOTP code
 * at dashboard login, and TWO_FA_REQUIRED=1 must block unenrolled admins.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createTestApp,
  createTestCoop,
  createTestMember,
  cleanupDatabase,
  prisma,
} from "./setup.js";
import { generateTotpSecret, totpAt } from "../src/lib/totp.js";
import { resetRateLimitPrefix } from "../src/lib/cache.js";

const APP_URL = "/api/admin/login";

function login(
  app: Awaited<ReturnType<typeof createTestApp>>,
  payload: { phone: string; pin: string; totp?: string },
) {
  return app.inject({ method: "POST", url: APP_URL, payload });
}

beforeEach(async () => {
  await cleanupDatabase();
  await resetRateLimitPrefix("login:");
  delete process.env.TWO_FA_REQUIRED;
});

afterEach(() => {
  delete process.env.TWO_FA_REQUIRED;
});

async function enrolledAdmin(coopId: string, phone: string, pin: string) {
  const admin = await createTestMember(coopId, { phone, role: "admin", pin });
  const secret = generateTotpSecret();
  await prisma.member.update({ where: { id: admin.id }, data: { totpSecret: secret } });
  return { admin, secret };
}

describe("admin dashboard 2FA", () => {
  it("asks for the authenticator code when the admin is enrolled", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("TFA001");
    const { admin } = await enrolledAdmin(coop.id, "2348044400001", "1234");

    const res = await login(app, { phone: admin.phone, pin: "1234" });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "totp_required" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects a wrong authenticator code", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("TFA002");
    const { admin } = await enrolledAdmin(coop.id, "2348044400002", "1234");

    const res = await login(app, { phone: admin.phone, pin: "1234", totp: "000000" });

    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("accepts a valid authenticator code and sets the auth cookie", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("TFA003");
    const { admin, secret } = await enrolledAdmin(coop.id, "2348044400003", "1234");

    const res = await login(app, {
      phone: admin.phone,
      pin: "1234",
      totp: totpAt(secret),
    });

    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).toContain("coop_token=");
  });

  it("rejects a replayed authenticator code", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("TFA005");
    const { admin, secret } = await enrolledAdmin(coop.id, "2348044400005", "1234");
    const code = totpAt(secret);

    const first = await login(app, { phone: admin.phone, pin: "1234", totp: code });
    expect(first.statusCode).toBe(200);

    const replay = await login(app, { phone: admin.phone, pin: "1234", totp: code });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ code: "totp_reused" });
    expect(replay.headers["set-cookie"]).toBeUndefined();
  });

  it("blocks unenrolled admins when TWO_FA_REQUIRED=1", async () => {
    process.env.TWO_FA_REQUIRED = "1";
    const app = await createTestApp();
    const coop = await createTestCoop("TFA004");
    const admin = await createTestMember(coop.id, {
      phone: "2348044400004",
      role: "admin",
      pin: "1234",
    });

    const res = await login(app, { phone: admin.phone, pin: "1234" });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "2fa_setup_required" });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
