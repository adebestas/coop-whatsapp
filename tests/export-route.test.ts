import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createTestApp, closeTestApp, prisma } from "./setup.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { sign } from "../src/lib/admin-auth.js";

const EXPORT_DIR = process.env.EXPORT_DIR ?? "exports";
const written: string[] = [];

async function makeCoop(code: string) {
  return prisma.cooperative.create({
    data: { name: `Coop ${code}`, code, adminPhone: "2348000000000" },
  });
}

async function makeAdmin(coopId: string, phone: string) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Admin ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role: "superadmin",
      status: "active",
      pin: hashPin("1234"),
      consentAt: new Date(),
      wallet: { create: {} },
    },
  });
}

describe("GET /api/export/:filename (coop scoping)", () => {
  beforeEach(async () => {
    process.env.ADMIN_JWT_SECRET = "test-admin-secret";
    await prisma.wallet.deleteMany();
    await prisma.member.deleteMany();
    await prisma.cooperative.deleteMany();
    await mkdir(EXPORT_DIR, { recursive: true });
  });

  afterAll(async () => {
    await closeTestApp();
    for (const f of written) await rm(join(EXPORT_DIR, f), { force: true }).catch(() => {});
  });

  it("serves the caller's own coop export but blocks another coop's and legacy names", async () => {
    const app = await createTestApp();
    const coopA = await makeCoop("EXPA");
    const coopB = await makeCoop("EXPB");
    const admin = await makeAdmin(coopA.id, "2348015550001");
    const token = sign(admin.phone, coopA.id, "superadmin");

    const own = `${coopA.id}-members-abcdef12.xlsx`;
    const other = `${coopB.id}-members-abcdef12.xlsx`;
    const legacy = `members-abcdef12.xlsx`;
    for (const f of [own, other, legacy]) {
      await writeFile(join(EXPORT_DIR, f), "dummy");
      written.push(f);
    }

    const ok = await app.inject({
      method: "GET",
      url: `/api/export/${own}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);

    const cross = await app.inject({
      method: "GET",
      url: `/api/export/${other}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cross.statusCode).toBe(403);

    const leg = await app.inject({
      method: "GET",
      url: `/api/export/${legacy}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(leg.statusCode).toBe(403);
  });
});
