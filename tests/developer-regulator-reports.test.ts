import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unlink } from "node:fs/promises";
import { prisma, createTestCoop } from "./setup.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/lib/security.js";
import { resetRateLimit } from "../src/lib/cache.js";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";
const app = buildApp();

async function login(phone: string, role: "owner" | "support"): Promise<string> {
  await prisma.platformAdmin.create({
    data: { name: role, phone, role, pin: hashPin("123456"), mustChangePin: false },
  });
  await resetRateLimit("devlogin:127.0.0.1");
  const res = await app.inject({
    method: "POST",
    url: "/api/developer/login",
    payload: { phone, pin: "123456" },
  });
  expect(res.statusCode).toBe(200);
  return (res.headers["set-cookie"] as string).split(";")[0];
}

const write = (cookie: string) => ({ cookie, "x-requested-with": "XMLHttpRequest" });

const createdFiles: string[] = [];

afterEach(async () => {
  for (const path of createdFiles.splice(0)) {
    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
});

beforeEach(async () => {
  await prisma.platformAdmin.deleteMany();
  await prisma.regulatorReport.deleteMany();
  await prisma.regulatorProfile.deleteMany();
});

describe("developer regulator reports", () => {
  it("lists profile and reports for a coop", async () => {
    const coop = await createTestCoop("DEVREG1");
    await prisma.regulatorProfile.create({
      data: { cooperativeId: coop.id, label: "Lagos Ministry", type: "ministry" },
    });
    const cookie = await login("2348000000101", "owner");

    const res = await app.inject({
      method: "GET",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.profile.label).toBe("Lagos Ministry");
    expect(body.reports).toEqual([]);
  });

  it("generates an annual pack and rejects invalid input", async () => {
    const coop = await createTestCoop("DEVREG2");
    const cookie = await login("2348000000102", "owner");

    const ok = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: write(cookie),
      payload: { year: 2026, packType: "statutory" },
    });
    expect(ok.statusCode).toBe(200);
    const okBody = JSON.parse(ok.body);
    expect(okBody.reportId).toBeTruthy();
    expect(okBody.ok).toBe(true);
    createdFiles.push(okBody.files.xlsx, okBody.files.pdf, okBody.files.csv);
    expect(okBody.files.xlsx).toBeTruthy();
    expect(okBody.files.pdf).toBeTruthy();
    expect(okBody.files.csv).toBeTruthy();

    const stringYearOk = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: write(cookie),
      payload: { year: "2026", packType: "statutory" },
    });
    expect(stringYearOk.statusCode).toBe(200);
    const stringYearBody = JSON.parse(stringYearOk.body);
    expect(stringYearBody.reportId).toBe(okBody.reportId);
    createdFiles.push(
      stringYearBody.files.xlsx,
      stringYearBody.files.pdf,
      stringYearBody.files.csv,
    );

    const badYear = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: write(cookie),
      payload: { year: 26 },
    });
    expect(badYear.statusCode).toBe(400);
    expect(JSON.parse(badYear.body).error).toMatch(/four-digit year/);

    const stringYear = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: write(cookie),
      payload: { year: "2099" },
    });
    expect(stringYear.statusCode).toBe(400);
    expect(JSON.parse(stringYear.body).error).toMatch(/four-digit year/);

    const coercedYear = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: write(cookie),
      payload: { year: ["2026"] },
    });
    expect(coercedYear.statusCode).toBe(400);

    const badPack = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: write(cookie),
      payload: { year: 2026, packType: "bogus" },
    });
    expect(badPack.statusCode).toBe(400);
    expect(JSON.parse(badPack.body).error).toMatch(/packType/);

    const missing = await app.inject({
      method: "GET",
      url: "/api/developer/coops/nope/regulator-reports",
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body).error).toMatch(/not found/i);
  });

  it("files a pack with an acknowledgement", async () => {
    const coop = await createTestCoop("DEVREG3");
    const cookie = await login("2348000000103", "owner");
    const report = await prisma.regulatorReport.create({
      data: {
        cooperativeId: coop.id,
        period: "2026",
        periodType: "annual",
        packType: "statutory",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports/${report.id}/file`,
      headers: write(cookie),
      payload: { acknowledgementId: "ACK-42", note: "Hand delivered" },
    });
    expect(res.statusCode).toBe(200);
    const saved = await prisma.regulatorReport.findUnique({ where: { id: report.id } });
    expect(saved!.acknowledgementId).toBe("ACK-42");
    expect(saved!.notes).toBe("Hand delivered");

    const unknown = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports/nope/file`,
      headers: write(cookie),
      payload: {},
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("keeps support role read-only", async () => {
    const coop = await createTestCoop("DEVREG4");
    const cookie = await login("2348000000104", "support");

    const read = await app.inject({
      method: "GET",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);

    const writeRes = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/regulator-reports`,
      headers: write(cookie),
      payload: { year: 2026 },
    });
    expect(writeRes.statusCode).toBe(403);
    expect(JSON.parse(writeRes.body).error).toMatch(/read-only|forbidden/i);
  });
});
