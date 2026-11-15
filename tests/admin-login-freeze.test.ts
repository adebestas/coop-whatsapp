/**
 * SEC-P1: failed admin logins must never be able to suspend the admin account.
 *
 * `recordSuspiciousEvent` auto-freezes (sets status=suspended) after 3 events in
 * an hour. Wiring that to failed logins turns the unauthenticated login form
 * into a targeted lockout primitive: anyone who knows an admin's phone number
 * can suspend them with 3 wrong PINs. Failed logins stay audited and alert the
 * superadmins, but the account is never frozen from this path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTestApp,
  createTestCoop,
  createTestMember,
  cleanupDatabase,
  prisma,
} from "./setup.js";
import { sendText } from "../src/lib/messaging.js";

const APP_URL = "/api/admin/login";

function login(app: Awaited<ReturnType<typeof createTestApp>>, phone: string, pin: string) {
  return app.inject({ method: "POST", url: APP_URL, payload: { phone, pin } });
}

beforeEach(async () => {
  await cleanupDatabase();
  vi.clearAllMocks();
});

describe("admin login failure lockout", () => {
  it("keeps the admin active after repeated wrong PINs and alerts superadmins", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("LOCK01");
    const admin = await createTestMember(coop.id, {
      phone: "2348033300001",
      role: "admin",
      pin: "2468",
    });
    await createTestMember(coop.id, { phone: "2348033300002", role: "superadmin" });

    for (let i = 0; i < 3; i++) {
      const res = await login(app, admin.phone, "0000");
      expect(res.statusCode).toBe(401);
    }

    const live = await prisma.member.findUnique({ where: { id: admin.id } });
    expect(live?.status).not.toBe("suspended");
    expect(live?.status).toBe("active");

    expect(vi.mocked(sendText)).toHaveBeenCalled();
    const audited = await prisma.auditLog.count({
      where: { targetId: admin.id, action: "security.suspicious.admin_login_failed" },
    });
    expect(audited).toBeGreaterThanOrEqual(3);

    // The correct PIN still works after the failed-attempt burst.
    const ok = await login(app, admin.phone, "2468");
    expect(ok.statusCode).toBe(200);
  });
});
