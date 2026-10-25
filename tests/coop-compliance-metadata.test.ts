import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./setup.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/lib/security.js";
import { signPlatformToken } from "../src/lib/platform-auth.js";
import { provisionCooperative } from "../src/services/cooperative-provisioning.js";
import { createCooperative } from "../src/services/cooperative.js";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";

describe("coop compliance metadata", () => {
  it("persists registration/tin/cvn/scuml/dpo fields", async () => {
    const { cooperativeId } = await provisionCooperative({
      name: "M",
      code: `M${Date.now()}`,
      adminPhone: "2348777777771",
    });
    const c = await prisma.cooperative.update({
      where: { id: cooperativeId },
      data: {
        registrationNumber: "EK/12345",
        tin: "12345678-0001",
        cvn: "CVN-0001",
        scumlStatus: "registered",
        dpoName: "Ada",
        dpoPhone: "2348777777772",
        dpoEmail: "dpo@example.com",
      },
    });
    expect(c.registrationNumber).toBe("EK/12345");
    expect(c.tin).toBe("12345678-0001");
    expect(c.cvn).toBe("CVN-0001");
    expect(c.scumlStatus).toBe("registered");
    expect(c.dpoName).toBe("Ada");
    expect(c.dpoPhone).toBe("2348777777772");
    expect(c.dpoEmail).toBe("dpo@example.com");
  });

  it("createCooperative persists a supplied registration number", async () => {
    const created = await createCooperative({
      name: "Reg Coop",
      code: `RC${Date.now()}`,
      registrationNumber: "RC/99887",
    });
    const row = await prisma.cooperative.findUnique({ where: { id: created.id } });
    expect(row?.registrationNumber).toBe("RC/99887");
  });

  it("provisionCooperative persists a supplied registration number", async () => {
    const { cooperativeId } = await provisionCooperative({
      name: "Prov Coop",
      code: `PV${Date.now()}`,
      adminPhone: "2348777777773",
      registrationNumber: "PV/11223",
    });
    const row = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });
    expect(row?.registrationNumber).toBe("PV/11223");
  });
});

describe("PATCH /api/developer/coops/:id", () => {
  const app = buildApp();
  let cookie: string;
  beforeEach(async () => {
    await prisma.platformAdmin.deleteMany();
    const owner = await prisma.platformAdmin.create({
      data: {
        name: "O",
        phone: "2348000000009",
        role: "owner",
        pin: hashPin("123456"),
        mustChangePin: false,
      },
    });
    const token = signPlatformToken({
      id: owner.id,
      phone: owner.phone,
      role: owner.role,
    });
    cookie = `coop_dev_token=${token}`;
  });

  const patch = (id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/developer/coops/${id}`,
      payload,
      headers: { cookie, "x-requested-with": "xmlhttprequest" },
    });

  const makeCoop = (code: string, extra: Record<string, unknown> = {}) =>
    prisma.cooperative.create({
      data: { name: code, code, state: "Lagos", ...extra },
    });

  it("updates whitelisted compliance fields and ignores unknown keys", async () => {
    const coop = await makeCoop(`C${Date.now()}`);
    const res = await patch(coop.id, {
      registrationNumber: "EK/12345",
      tin: "TIN-1",
      cvn: "CVN-1",
      scumlStatus: "registered",
      dpoName: "Ada",
      dpoPhone: "2348777777772",
      dpoEmail: "dpo@example.com",
      code: "HACKED",
      status: "suspended",
      tokensValidAfter: null,
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(row?.registrationNumber).toBe("EK/12345");
    expect(row?.tin).toBe("TIN-1");
    expect(row?.cvn).toBe("CVN-1");
    expect(row?.scumlStatus).toBe("registered");
    expect(row?.dpoName).toBe("Ada");
    expect(row?.dpoPhone).toBe("2348777777772");
    expect(row?.dpoEmail).toBe("dpo@example.com");
    expect(row?.code).toBe(coop.code);
    expect(row?.status).toBe("active");
  });

  it("normalises blank strings to null", async () => {
    const coop = await makeCoop(`C${Date.now()}`, { registrationNumber: "OLD" });
    const res = await patch(coop.id, { registrationNumber: "   " });
    expect(res.statusCode).toBe(200);
    const row = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(row?.registrationNumber).toBeNull();
  });

  it("rejects a patch carrying no recognised fields", async () => {
    const coop = await makeCoop(`C${Date.now()}`);
    const res = await patch(coop.id, { nope: "x" });
    expect(res.statusCode).toBe(400);
  });

  it("404s for an unknown cooperative", async () => {
    const res = await patch("does-not-exist", { tin: "x" });
    expect(res.statusCode).toBe(404);
  });

  it("requires authentication", async () => {
    const coop = await makeCoop(`C${Date.now()}`);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/developer/coops/${coop.id}`,
      payload: { tin: "x" },
      headers: { "x-requested-with": "xmlhttprequest" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("requires the CSRF header", async () => {
    const coop = await makeCoop(`C${Date.now()}`);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/developer/coops/${coop.id}`,
      payload: { tin: "x" },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a non-string compliance value", async () => {
    const coop = await makeCoop(`C${Date.now()}`);
    const res = await patch(coop.id, { tin: { nested: true } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-object body", async () => {
    const coop = await makeCoop(`C${Date.now()}`);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/developer/coops/${coop.id}`,
      payload: JSON.stringify("hello"),
      headers: {
        cookie,
        "x-requested-with": "xmlhttprequest",
        "content-type": "application/json",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("blocks the read-only support role from patching", async () => {
    const coop = await makeCoop(`C${Date.now()}`);
    const support = await prisma.platformAdmin.create({
      data: {
        name: "S",
        phone: "2348000000010",
        role: "support",
        pin: hashPin("123456"),
        mustChangePin: false,
      },
    });
    const token = signPlatformToken({ id: support.id, phone: support.phone, role: "support" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/developer/coops/${coop.id}`,
      payload: { tin: "x" },
      headers: { authorization: `Bearer ${token}`, "x-requested-with": "xmlhttprequest" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("writes a platform audit entry", async () => {
    const coop = await makeCoop(`C${Date.now()}`);
    const res = await patch(coop.id, { tin: "AUDIT-1" });
    expect(res.statusCode).toBe(200);
    const entry = await prisma.platformAuditLog.findFirst({
      where: { cooperativeId: coop.id, action: "coop.compliance.set" },
    });
    expect(entry).not.toBeNull();
    expect(entry?.detail).toContain("AUDIT-1");
  });

  it("POST /coops persists a registration number supplied at creation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/developer/coops",
      payload: {
        name: "New Coop",
        code: `NX${Date.now()}`,
        superAdmin: { phone: "2348555555551" },
        registrationNumber: "NX/1",
      },
      headers: { cookie, "x-requested-with": "xmlhttprequest" },
    });
    expect(res.statusCode).toBe(200);
    const id = JSON.parse(res.body).cooperativeId;
    const row = await prisma.cooperative.findUnique({ where: { id } });
    expect(row?.registrationNumber).toBe("NX/1");
  });
});
