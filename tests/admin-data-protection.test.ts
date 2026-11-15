import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  prisma,
  createTestApp,
  createTestCoop,
  createTestMember,
  cleanupDatabase,
} from "./setup.js";
import { resetRateLimitPrefix } from "../src/lib/cache.js";

beforeEach(async () => {
  await cleanupDatabase();
  await resetRateLimitPrefix("login:");
});
afterAll(cleanupDatabase);

async function loginAs(app: FastifyInstance, phone: string, pin = "1234"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    payload: { phone, pin },
  });
  expect(res.statusCode).toBe(200);
  const cookie = String(res.headers["set-cookie"]);
  return `coop_token=${cookie.split("coop_token=")[1].split(";")[0]}`;
}

describe("admin data protection register", () => {
  it("lists DPIA records for the cooperative only", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("DPA1");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348094000001",
      pin: "1234",
    });
    const dpia = await prisma.dpiaRecord.create({
      data: {
        cooperativeId: coop.id,
        title: "WhatsApp messaging",
        activity: "Member communication",
        status: "approved",
        ownerName: "Data Officer",
      },
    });
    const otherCoop = await createTestCoop("DPA2");
    await prisma.dpiaRecord.create({
      data: { cooperativeId: otherCoop.id, title: "Other", activity: "Other" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/data-protection/dpia",
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.records).toHaveLength(1);
    expect(body.records[0]).toMatchObject({
      id: dpia.id,
      title: "WhatsApp messaging",
      status: "approved",
    });
  });

  it("lists breach records for the cooperative only", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("BRC1");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348094000011",
      pin: "1234",
    });
    const breach = await prisma.dataBreach.create({
      data: {
        cooperativeId: coop.id,
        reference: "BR-20260101-0001",
        title: "Lost phone",
        description: "Member phone lost",
        discoveredAt: new Date("2026-01-01"),
        status: "contained",
        affectedCount: 1,
      },
    });
    const otherCoop = await createTestCoop("BRC2");
    await prisma.dataBreach.create({
      data: {
        cooperativeId: otherCoop.id,
        reference: "BR-20260101-0002",
        title: "Other",
        description: "Other",
        discoveredAt: new Date("2026-01-01"),
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/data-protection/breaches",
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.breaches).toHaveLength(1);
    expect(body.breaches[0]).toMatchObject({
      id: breach.id,
      reference: "BR-20260101-0001",
      affectedCount: 1,
      status: "contained",
    });
  });

  it("summarises consent by type and grant status for the cooperative", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("CON1");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348094000021",
      pin: "1234",
    });
    const member = await createTestMember(coop.id, { phone: "2348094000022" });
    await prisma.dataConsent.create({
      data: { memberId: member.id, consentType: "messaging", granted: true },
    });
    await prisma.dataConsent.create({
      data: { memberId: member.id, consentType: "messaging", granted: false },
    });
    await prisma.dataConsent.create({
      data: { memberId: member.id, consentType: "data_export", granted: true },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/data-protection/consents",
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.consents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ consentType: "messaging", granted: 1, denied: 1 }),
        expect.objectContaining({ consentType: "data_export", granted: 1, denied: 0 }),
      ]),
    );
  });
});
