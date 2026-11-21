import { beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  createTestApp,
  createTestCoop,
  createTestMember,
  cleanupDatabase,
} from "./setup.js";
import { forbiddenFieldsIn, pickAllowed, stripForbidden } from "../src/lib/pick.js";
import { addCoopAdmin } from "../src/services/cooperative-provisioning.js";
import { setCoopAdminRole } from "../src/services/platform-coops.js";
import { createPlatformAdmin } from "../src/services/platform-admin.js";
import { bulkImportMembers } from "../src/services/bulk-import.js";

const PRIVILEGED = {
  id: "attacker-chosen-id",
  userId: "someone-elses-account",
  role: "superadmin",
  isAdmin: true,
  plan: "enterprise",
  cooperativeId: "some-other-coop",
  status: "suspended",
  balance: 999_999_999,
  pin: "0000",
  totpSecret: "JBSWY3DPEHPK3PXP",
  phoneVerified: true,
};

async function adminSession(coopId: string, phone: string) {
  const admin = await createTestMember(coopId, { role: "superadmin", phone, pin: "1234" });
  const app = await createTestApp();
  const login = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    payload: { phone, pin: "1234" },
  });
  expect(login.statusCode).toBe(200);
  const token = String(login.headers["set-cookie"]).split("coop_token=")[1].split(";")[0];
  return { app, admin, cookie: `coop_token=${token}` };
}

beforeEach(async () => {
  await cleanupDatabase();
});

describe("pick helpers", () => {
  it("lists deny-listed fields and never copies them", () => {
    expect(forbiddenFieldsIn(PRIVILEGED).sort()).toEqual(
      [
        "balance",
        "cooperativeId",
        "id",
        "isAdmin",
        "phoneVerified",
        "pin",
        "plan",
        "role",
        "status",
        "totpSecret",
        "userId",
      ].sort(),
    );
    expect(pickAllowed(PRIVILEGED, ["name", "type"])).toEqual({});
    expect(stripForbidden(PRIVILEGED)).toEqual({});
  });

  it("copies only allow-listed, defined fields", () => {
    expect(pickAllowed({ name: "Goal", type: "goal", extra: 1 }, ["name", "type"])).toEqual({
      name: "Goal",
      type: "goal",
    });
    expect(pickAllowed({ name: undefined }, ["name"])).toEqual({});
  });
});

describe("dashboard writes reject privileged body fields", () => {
  it("rejects role/isAdmin/plan/userId on a savings product and writes nothing", async () => {
    const coop = await createTestCoop("MASS1");
    const { app, admin, cookie } = await adminSession(coop.id, "2348070000001");

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/savings/products",
      headers: { cookie, "x-requested-with": "XMLHttpRequest" },
      payload: { type: "goal", name: "Holiday", ...PRIVILEGED },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual(
      expect.arrayContaining(["role", "isAdmin", "plan", "userId"]),
    );

    expect(await prisma.savingsProduct.count({ where: { name: "Holiday" } })).toBe(0);

    const stored = await prisma.member.findUnique({ where: { id: admin.id } });
    expect(stored?.role).toBe("superadmin");
    expect(stored?.status).toBe("active");
    expect(stored?.phoneVerified).toBe(false);
    expect(stored?.totpSecret).toBeNull();
    expect((await prisma.wallet.findUnique({ where: { memberId: admin.id } }))?.balance ?? 0).toBe(
      0,
    );
  });

  it("accepts the same product when only allow-listed fields are sent", async () => {
    const coop = await createTestCoop("MASS2");
    const { app, cookie } = await adminSession(coop.id, "2348070000004");

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/savings/products",
      headers: { cookie, "x-requested-with": "XMLHttpRequest" },
      payload: { type: "goal", name: "Holiday", targetAmount: 100_000 },
    });
    expect(res.statusCode).toBe(200);

    const product = await prisma.savingsProduct.findFirst({ where: { name: "Holiday" } });
    expect(product?.cooperativeId).toBe(coop.id);
  });

  it("rejects hostile fields on payroll/set", async () => {
    const coop = await createTestCoop("MASS3");
    const { app, cookie } = await adminSession(coop.id, "2348070000005");
    const target = await createTestMember(coop.id, {
      phone: "2348070000006",
      role: "superadmin",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/payroll/set",
      headers: { cookie, "x-requested-with": "XMLHttpRequest" },
      payload: { memberCode: target.code, amount: 50_000, ...PRIVILEGED },
    });
    expect(res.statusCode).toBe(400);

    const after = await prisma.member.findUnique({ where: { id: target.id } });
    expect(after?.salaryAmount ?? 0).toBe(0);
    expect(after?.role).toBe("superadmin");
  });

  it("sets a salary without letting the body change role, status or wallet", async () => {
    const coop = await createTestCoop("MASS4");
    const { app, cookie } = await adminSession(coop.id, "2348070000007");
    const target = await createTestMember(coop.id, {
      phone: "2348070000008",
      role: "superadmin",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/payroll/set",
      headers: { cookie, "x-requested-with": "XMLHttpRequest" },
      payload: { memberCode: target.code, amount: 50_000 },
    });
    expect(res.statusCode).toBe(200);

    const after = await prisma.member.findUnique({ where: { id: target.id } });
    expect(after?.role).toBe("superadmin");
    expect(after?.status).toBe("active");
    expect(after?.salaryAmount).toBe(50_000);
    expect((await prisma.wallet.findUnique({ where: { memberId: target.id } }))?.balance ?? 0).toBe(
      0,
    );
  });
});

describe("role changes are enforced server-side", () => {
  it("refuses to create a coop admin with any role outside admin|superadmin", async () => {
    const coop = await createTestCoop("MASS5");
    await expect(
      addCoopAdmin(coop.id, { phone: "2348070000010", role: "owner" as unknown as "admin" }),
    ).rejects.toThrow(/invalid coop admin role/);
    expect(await prisma.member.count({ where: { phone: "2348070000010" } })).toBe(0);
  });

  it("promotes an existing member inside the cooperative", async () => {
    const coop = await createTestCoop("MASS6");
    const member = await createTestMember(coop.id, { phone: "2348070000011" });

    await setCoopAdminRole(coop.id, member.id, "admin");

    const after = await prisma.member.findUnique({ where: { id: member.id } });
    expect(after?.role).toBe("admin");
  });

  it("cannot promote a member that belongs to another cooperative", async () => {
    const attackingCoop = await createTestCoop("MASS7");
    const otherCoop = await createTestCoop("MASS8");
    const victim = await createTestMember(otherCoop.id, { phone: "2348070000012" });

    await expect(setCoopAdminRole(attackingCoop.id, victim.id, "superadmin")).rejects.toThrow(
      /member not found/,
    );

    const after = await prisma.member.findUnique({ where: { id: victim.id } });
    expect(after?.role).toBe("member");
  });

  it("rejects an unknown platform role and keeps the schema default otherwise", async () => {
    await expect(
      createPlatformAdmin({ name: "Mallory", phone: "2348070000013", role: "root" }),
    ).rejects.toThrow(/invalid role/);

    const created = await createPlatformAdmin({ name: "Defaulted", phone: "2348070000014" });
    expect(created.role).toBe("developer");
  });

  it("imports members as plain members even when the file names a privileged role", async () => {
    const coop = await createTestCoop("MASS9");
    const csv = "Name,Phone,Role\nEve Importer,2348070000015,superadmin\n";

    const result = await bulkImportMembers(coop.id, Buffer.from(csv), "members.csv");
    expect(result.imported).toBe(1);

    const imported = await prisma.member.findUnique({
      where: { cooperativeId_phone: { cooperativeId: coop.id, phone: "2348070000015" } },
    });
    expect(imported?.role).toBe("member");
  });
});
