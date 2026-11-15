import { describe, it, expect, beforeEach } from "vitest";
import { prisma, createTestCoop, createTestMember } from "./setup.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/lib/security.js";
import { resetRateLimit } from "../src/lib/cache.js";
import { totpAt } from "../src/lib/totp.js";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";
const app = buildApp();
const TEST_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

let devPhoneSeq = 1;

async function loginDev(role: "owner" | "developer" | "support" = "owner"): Promise<string> {
  const phone = `23499${String(devPhoneSeq++).padStart(8, "0")}`;
  await prisma.platformAdmin.create({
    data: {
      name: role,
      phone,
      role,
      pin: hashPin("123456"),
      mustChangePin: false,
      totpSecret: role === "support" ? null : TEST_TOTP_SECRET,
      totpEnabled: role !== "support",
    },
  });
  await resetRateLimit("devlogin:127.0.0.1");
  const res = await app.inject({
    method: "POST",
    url: "/api/developer/login",
    payload: {
      phone,
      pin: "123456",
      totp: role === "support" ? undefined : totpAt(TEST_TOTP_SECRET),
    },
  });
  expect(res.statusCode).toBe(200);
  return (res.headers["set-cookie"] as string).split(";")[0];
}

const writeHeaders = (cookie: string) => ({
  cookie,
  "x-requested-with": "XMLHttpRequest",
});

async function createSandboxCoop(code: string) {
  const coop = await createTestCoop(code);
  await prisma.cooperative.update({ where: { id: coop.id }, data: { isSandbox: true } });
  return coop;
}

beforeEach(async () => {
  await prisma.platformAdmin.deleteMany();
});

describe("Developer Console â€” Cooperative WhatsApp Bot Simulator", () => {
  it("lists cooperative members for simulator identity selection", async () => {
    const cookie = await loginDev("developer");
    const coop = await createSandboxCoop("SIMCOOP1");
    const member = await createTestMember(coop.id, {
      phone: "2348011112222",
      name: "Tunde Simulator",
      role: "member",
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/developer/coops/${coop.id}/simulate/members`,
      headers: writeHeaders(cookie),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.members).toBeInstanceOf(Array);
    expect(body.members.length).toBeGreaterThanOrEqual(1);
    const found = body.members.find((m: any) => m.phone === member.phone);
    expect(found).toBeDefined();
    expect(found.name).toBe("Tunde Simulator");
  });

  it("returns 404 when listing simulator members for nonexistent cooperative", async () => {
    const cookie = await loginDev("developer");
    const res = await app.inject({
      method: "GET",
      url: `/api/developer/coops/nonexistent-id/simulate/members`,
      headers: writeHeaders(cookie),
    });
    expect(res.statusCode).toBe(404);
  });

  it("simulates a WhatsApp message turn and captures responses safely in-memory", async () => {
    const cookie = await loginDev("developer");
    const coop = await createSandboxCoop("SIMCOOP2");
    const member = await createTestMember(coop.id, {
      phone: "2348022223333",
      name: "Simulated Member",
    });

    // Send a command through the simulator
    const res = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/simulate`,
      headers: writeHeaders(cookie),
      payload: {
        phone: member.phone,
        text: "menu",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.phone).toBe(member.phone);
    expect(body.input).toBe("menu");
    expect(body.messages).toBeInstanceOf(Array);
    // There should be at least one bot reply captured in simulator scope
    expect(body.messages.length).toBeGreaterThan(0);
    expect(body.state).toBeDefined();
    expect(body.state.member).toBeDefined();
    expect(body.state.member.name).toBe("Simulated Member");
  });

  it("rejects simulation request with empty text", async () => {
    const cookie = await loginDev("developer");
    const coop = await createSandboxCoop("SIMCOOP3");

    const res = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/simulate`,
      headers: writeHeaders(cookie),
      payload: {
        phone: "2348033334444",
        text: "   ",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toContain("text message is required");
  });

  it("returns 404 when simulating on nonexistent cooperative", async () => {
    const cookie = await loginDev("developer");
    const res = await app.inject({
      method: "POST",
      url: `/api/developer/coops/nonexistent-coop-id/simulate`,
      headers: writeHeaders(cookie),
      payload: {
        phone: "2348033334444",
        text: "balance",
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it("denies support role access to simulator member PII", async () => {
    const cookie = await loginDev("support");
    const coop = await createSandboxCoop("SIMCOOP4");

    const res = await app.inject({
      method: "GET",
      url: `/api/developer/coops/${coop.id}/simulate/members`,
      headers: writeHeaders(cookie),
    });

    expect(res.statusCode).toBe(403);
  });

  it("refuses to simulate a non-sandbox cooperative", async () => {
    const cookie = await loginDev("developer");
    const coop = await createTestCoop("SIMCOOP5");

    const res = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/simulate`,
      headers: writeHeaders(cookie),
      payload: { phone: "2348055556666", text: "menu" },
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).error).toContain("sandbox");
  });

  it("rejects a phone that belongs to another cooperative", async () => {
    const cookie = await loginDev("developer");
    const coop = await createSandboxCoop("SIMCOOP6");
    const other = await createSandboxCoop("SIMCOOP7");
    await createTestMember(other.id, { phone: "2348077778888", name: "Other Coop Member" });

    const res = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/simulate`,
      headers: writeHeaders(cookie),
      payload: { phone: "2348077778888", text: "menu" },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toContain("does not belong");
  });
});
