import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "./setup.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/lib/security.js";
import { signPlatformToken } from "../src/lib/platform-auth.js";
import { SANDBOX_CODE } from "../src/services/sandbox.js";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";
const app = buildApp();

async function ownerCookie(): Promise<{ cookie: string; id: string }> {
  const owner = await prisma.platformAdmin.create({
    data: {
      name: "Owner",
      phone: "2348000000210",
      role: "owner",
      pin: hashPin("123456"),
      mustChangePin: false,
      totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
      totpEnabled: true,
    },
  });
  const token = signPlatformToken({ id: owner.id, phone: owner.phone, role: owner.role });
  return { cookie: `coop_dev_token=${token}`, id: owner.id };
}

const headers = (cookie: string) => ({ cookie, "x-requested-with": "XMLHttpRequest" });

describe("developer sandbox provisioning endpoint", () => {
  beforeEach(async () => {
    await prisma.platformAdmin.deleteMany();
    await prisma.cooperative.deleteMany({ where: { isSandbox: true } });
  });

  it("returns 404 without seeding a sandbox on a plain read", async () => {
    const { cookie } = await ownerCookie();
    const res = await app.inject({
      method: "GET",
      url: "/api/developer/sandbox",
      headers: headers(cookie),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("sandbox_not_provisioned");
    expect(await prisma.cooperative.count({ where: { isSandbox: true } })).toBe(0);
  });

  it("provisions on explicit POST and records an audit event", async () => {
    const { cookie } = await ownerCookie();
    const res = await app.inject({
      method: "POST",
      url: "/api/developer/sandbox/ensure",
      headers: headers(cookie),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cooperative.code).toBe(SANDBOX_CODE);

    const audit = await prisma.platformAuditLog.findFirst({
      where: { action: "sandbox.provision" },
      select: { action: true, targetType: true },
    });
    expect(audit?.targetType).toBe("cooperative");

    const read = await app.inject({
      method: "GET",
      url: "/api/developer/sandbox",
      headers: headers(cookie),
    });
    expect(read.statusCode).toBe(200);
  });
});
