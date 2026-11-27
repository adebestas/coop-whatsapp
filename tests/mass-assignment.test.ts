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
import { signPlatformToken } from "../src/lib/platform-auth.js";
import { hashPin } from "../src/lib/security.js";

process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";

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

async function devSession(role: "owner" | "developer" = "owner") {
  const admin = await prisma.platformAdmin.create({
    data: {
      name: "Platform Admin",
      phone: `2348071${Math.floor(100000 + Math.random() * 899999)}`,
      role,
      pin: hashPin("123456"),
      mustChangePin: false,
      totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
      totpEnabled: true,
    },
  });
  const token = signPlatformToken({ id: admin.id, phone: admin.phone, role: admin.role });
  return {
    admin,
    headers: {
      cookie: `coop_dev_token=${token}`,
      "x-requested-with": "xmlhttprequest",
    },
  };
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

describe("developer console ignores privileged body fields", () => {
  it("creates a coop admin from explicit fields only", async () => {
    const coop = await createTestCoop("MASS10");
    const app = await createTestApp();
    const { headers } = await devSession();

    const res = await app.inject({
      method: "POST",
      url: `/api/developer/coops/${coop.id}/admins`,
      headers,
      payload: { ...PRIVILEGED, phone: "2348070000020", name: "Mallory", role: "owner" },
    });
    expect(res.statusCode).toBe(200);

    const member = await prisma.member.findUnique({
      where: { cooperativeId_phone: { cooperativeId: coop.id, phone: "2348070000020" } },
    });
    expect(member?.id).not.toBe("attacker-chosen-id");
    expect(member?.role).toBe("admin");
    expect(member?.status).toBe("active");
    expect(member?.phoneVerified).toBe(false);
    expect(member?.pin).not.toBe("0000");
    expect(member?.cooperativeId).toBe(coop.id);

    const wallet = await prisma.wallet.findUnique({ where: { memberId: member!.id } });
    expect(wallet?.balance ?? 0).toBe(0);
  });

  it("changes only the role when privileged extras ride along", async () => {
    const coop = await createTestCoop("MASS11");
    const app = await createTestApp();
    const { headers } = await devSession();
    const target = await createTestMember(coop.id, { phone: "2348070000021" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/developer/coops/${coop.id}/admins/${target.id}`,
      headers,
      payload: { ...PRIVILEGED, role: "admin" },
    });
    expect(res.statusCode).toBe(200);

    const after = await prisma.member.findUnique({ where: { id: target.id } });
    expect(after?.role).toBe("admin");
    expect(after?.status).toBe("active");
    expect(after?.phoneVerified).toBe(false);

    const wallet = await prisma.wallet.findUnique({ where: { memberId: target.id } });
    expect(wallet?.balance ?? 0).toBe(0);
  });

  it("ignores a client-chosen id, pin and flags on platform admin creation", async () => {
    const app = await createTestApp();
    const { admin: owner, headers } = await devSession();

    const res = await app.inject({
      method: "POST",
      url: "/api/developer/admins",
      headers,
      payload: {
        ...PRIVILEGED,
        name: "Mallory",
        phone: "2348070000022",
        role: "developer",
        active: false,
        mustChangePin: false,
      },
    });
    expect(res.statusCode).toBe(200);

    const created = await prisma.platformAdmin.findUnique({ where: { phone: "2348070000022" } });
    expect(created).not.toBeNull();
    expect(created?.id).not.toBe("attacker-chosen-id");
    expect(created?.role).toBe("developer");
    expect(created?.active).toBe(true);
    expect(created?.mustChangePin).toBe(true);
    expect(created?.phoneVerified).toBe(false);
    expect(created?.totpSecret).toBeNull();
    expect(created?.pin).not.toBe("0000");
    expect(created?.createdById).toBe(owner.id);
  });

  it("ignores role, plan and ownership fields on coop config updates", async () => {
    const coop = await createTestCoop("MASS12");
    const app = await createTestApp();
    const { headers } = await devSession();

    const extras = {
      id: PRIVILEGED.id,
      userId: PRIVILEGED.userId,
      role: PRIVILEGED.role,
      isAdmin: PRIVILEGED.isAdmin,
      plan: PRIVILEGED.plan,
      cooperativeId: PRIVILEGED.cooperativeId,
      balance: PRIVILEGED.balance,
      pin: PRIVILEGED.pin,
      totpSecret: PRIVILEGED.totpSecret,
      phoneVerified: PRIVILEGED.phoneVerified,
    };

    const res = await app.inject({
      method: "PATCH",
      url: `/api/developer/coops/${coop.id}/config`,
      headers,
      payload: { ...extras, status: "active", loanInterestRate: 15 },
    });
    expect(res.statusCode).toBe(200);

    const after = await prisma.cooperative.findUnique({ where: { id: coop.id } });
    expect(after?.status).toBe("active");
    expect(await prisma.subscription.findUnique({ where: { cooperativeId: coop.id } })).toBeNull();
    expect(await prisma.member.count({ where: { cooperativeId: coop.id } })).toBe(0);

    const cfg = await prisma.cooperativeConfig.findUnique({ where: { cooperativeId: coop.id } });
    expect(cfg?.loanInterestRate).toBe(15);
  });
});
