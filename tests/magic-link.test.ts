import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  prisma,
  createTestApp,
  createTestCoop,
  createTestMember,
  cleanupDatabase,
} from "./setup.js";
import { hashPin } from "../src/lib/security.js";
import { issueMemberMagicLink, issuePlatformMagicLink } from "../src/lib/magic-link.js";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";

beforeEach(async () => {
  await cleanupDatabase();
  await prisma.magicLinkToken.deleteMany();
});

async function verifiedAdmin(coopId: string, email: string) {
  const member = await createTestMember(coopId, { role: "admin" });
  await prisma.member.update({
    where: { id: member.id },
    data: { email, emailVerifiedAt: new Date() },
  });
  return member;
}

describe("member magic-link sign-in", () => {
  it("answers 202 for unknown addresses and stores nothing", async () => {
    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/magic-link/request",
      payload: { email: "nobody@example.com" },
    });
    expect(res.statusCode).toBe(202);
    expect(await prisma.magicLinkToken.count()).toBe(0);
  });

  it("stores the link only as a hash and never in plaintext", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("MAGIC1");
    await verifiedAdmin(coop.id, "admin1@example.com");

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/magic-link/request",
      payload: { email: "admin1@example.com" },
    });
    expect(res.statusCode).toBe(202);

    const rows = await prisma.magicLinkToken.findMany();
    expect(rows.length).toBe(1);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("revokes the previous link when a new one is requested", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("MAGIC2");
    const member = await verifiedAdmin(coop.id, "admin2@example.com");
    const issue = () =>
      issueMemberMagicLink({
        memberId: member.id,
        cooperativeId: coop.id,
        email: "admin2@example.com",
        ip: "203.0.113.7",
      });

    const first = await issue();
    await issue();
    const rows = await prisma.magicLinkToken.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.length).toBe(2);
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[1].revokedAt).toBeNull();

    const stale = await app.inject({
      method: "POST",
      url: "/api/admin/magic-link/consume",
      payload: { token: first.token },
    });
    expect(stale.statusCode).toBe(401);
  });

  it("consumes the link exactly once and mints a session", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("MAGIC3");
    const member = await verifiedAdmin(coop.id, "admin3@example.com");
    const { token } = await issueMemberMagicLink({
      memberId: member.id,
      cooperativeId: coop.id,
      email: "admin3@example.com",
      ip: "203.0.113.7",
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/admin/magic-link/consume",
      payload: { token },
    });
    expect(first.statusCode).toBe(200);
    expect(String(first.headers["set-cookie"])).toContain("coop_token=");
    expect(first.json().member.role).toBe("admin");
    expect(createHash("sha256").update(token).digest("hex")).toBe(
      (await prisma.magicLinkToken.findFirst())?.tokenHash,
    );

    const second = await app.inject({
      method: "POST",
      url: "/api/admin/magic-link/consume",
      payload: { token },
    });
    expect(second.statusCode).toBe(401);
  });

  it("refuses an expired link", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("MAGIC4");
    const member = await verifiedAdmin(coop.id, "admin4@example.com");
    const { token } = await issueMemberMagicLink({
      memberId: member.id,
      cooperativeId: coop.id,
      email: "admin4@example.com",
      ip: "203.0.113.7",
    });
    await prisma.magicLinkToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/magic-link/consume",
      payload: { token },
    });
    expect(res.statusCode).toBe(401);
  });

  it("still demands TOTP when the admin is enrolled", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("MAGIC5");
    const member = await verifiedAdmin(coop.id, "admin5@example.com");
    await prisma.member.update({
      where: { id: member.id },
      data: { totpSecret: "JBSWY3DPEHPK3PXP" },
    });
    const { token } = await issueMemberMagicLink({
      memberId: member.id,
      cooperativeId: coop.id,
      email: "admin5@example.com",
      ip: "203.0.113.7",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/magic-link/consume",
      payload: { token },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("totp_required");
    expect((await prisma.magicLinkToken.findFirst())?.usedAt).toBeNull();
  });
});

describe("operator magic-link sign-in", () => {
  async function operator(email: string) {
    return prisma.platformAdmin.create({
      data: {
        name: "Operator",
        phone: `23480${Math.floor(10000000 + Math.random() * 80000000)}`,
        role: "developer",
        pin: hashPin("123456"),
        mustChangePin: false,
        email,
        emailVerifiedAt: new Date(),
      },
    });
  }

  it("mints a platform session once", async () => {
    const app = await createTestApp();
    const admin = await operator("dev@example.com");

    const req = await app.inject({
      method: "POST",
      url: "/api/developer/magic-link/request",
      payload: { email: "dev@example.com" },
    });
    expect(req.statusCode).toBe(202);
    expect(await prisma.magicLinkToken.count()).toBe(1);

    const { token } = await issuePlatformMagicLink({
      platformAdminId: admin.id,
      email: "dev@example.com",
      ip: "203.0.113.7",
    });
    const first = await app.inject({
      method: "POST",
      url: "/api/developer/magic-link/consume",
      payload: { token },
    });
    expect(first.statusCode).toBe(200);
    expect(String(first.headers["set-cookie"])).toContain("coop_dev_token=");

    const second = await app.inject({
      method: "POST",
      url: "/api/developer/magic-link/consume",
      payload: { token },
    });
    expect(second.statusCode).toBe(401);
  });
});
