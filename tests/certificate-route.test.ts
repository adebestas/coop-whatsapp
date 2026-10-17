import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, closeTestApp, prisma } from "./setup.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";

async function makeCoop(code: string) {
  return prisma.cooperative.create({
    data: { name: `Coop ${code}`, code, adminPhone: "2348000000000" },
  });
}

async function makeMember(coopId: string, phone: string) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      pin: hashPin("1234"),
      consentAt: new Date(),
      wallet: { create: {} },
    },
  });
}

async function makeCert(coopId: string, memberId: string, ref: string, revoked = false) {
  return prisma.literacyCertificate.create({
    data: {
      cooperativeId: coopId,
      memberId,
      referenceCode: ref,
      score: 6,
      totalQuestions: 6,
      ...(revoked ? { revokedAt: new Date() } : {}),
    },
  });
}

describe("GET /api/certificate/:code", () => {
  beforeEach(async () => {
    await prisma.literacyCertificate.deleteMany();
    await prisma.wallet.deleteMany();
    await prisma.member.deleteMany();
    await prisma.cooperative.deleteMany();
  });

  afterAll(async () => {
    await closeTestApp();
  });

  it("streams a PDF for a valid reference suffix", async () => {
    const app = await createTestApp();
    const coop = await makeCoop("CERT1");
    const member = await makeMember(coop.id, "2348014440001");
    await makeCert(coop.id, member.id, "CERT-CERT1-ABCDEFGHJK");

    const res = await app.inject({ method: "GET", url: "/api/certificate/ABCDEFGHJK" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("inline");
    expect(res.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("resolves a full reference code too", async () => {
    const app = await createTestApp();
    const coop = await makeCoop("CERT2");
    const member = await makeMember(coop.id, "2348014440002");
    await makeCert(coop.id, member.id, "CERT-CERT2-QWERTYUIOP");

    const res = await app.inject({ method: "GET", url: "/api/certificate/CERT-CERT2-QWERTYUIOP" });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("404s for an unknown code", async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/certificate/NOPE123456" });
    expect(res.statusCode).toBe(404);
  });

  it("404s for a revoked certificate", async () => {
    const app = await createTestApp();
    const coop = await makeCoop("CERT3");
    const member = await makeMember(coop.id, "2348014440003");
    await makeCert(coop.id, member.id, "CERT-CERT3-ZZZZZZZZZZ", true);

    const res = await app.inject({ method: "GET", url: "/api/certificate/ZZZZZZZZZZ" });
    expect(res.statusCode).toBe(404);
  });

  it("rate-limits enumeration attempts", async () => {
    const app = await createTestApp();
    let saw429 = false;
    for (let i = 0; i < 60; i++) {
      const res = await app.inject({ method: "GET", url: `/api/certificate/MISS${i}` });
      if (res.statusCode === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});
