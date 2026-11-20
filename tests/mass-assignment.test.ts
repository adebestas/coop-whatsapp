import { beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  createTestApp,
  createTestCoop,
  createTestMember,
  cleanupDatabase,
} from "./setup.js";
import { forbiddenFieldsIn, pickAllowed, stripForbidden } from "../src/lib/pick.js";

const PRIVILEGED = {
  id: "attacker-chosen-id",
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

describe("dashboard writes ignore privileged body fields", () => {
  it("creates a savings product inside the caller's coop and leaves the admin untouched", async () => {
    const coop = await createTestCoop("MASS1");
    const { app, admin, cookie } = await adminSession(coop.id, "2348070000001");

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/savings/products",
      headers: { cookie, "x-requested-with": "XMLHttpRequest" },
      payload: { type: "goal", name: "Holiday", ...PRIVILEGED },
    });
    expect(res.statusCode).toBe(200);

    const product = await prisma.savingsProduct.findFirst({ where: { name: "Holiday" } });
    expect(product?.cooperativeId).toBe(coop.id);

    const stored = await prisma.member.findUnique({ where: { id: admin.id } });
    expect(stored?.role).toBe("superadmin");
    expect(stored?.status).toBe("active");
    expect(stored?.phoneVerified).toBe(false);
    expect(stored?.totpSecret).toBeNull();
    expect((await prisma.wallet.findUnique({ where: { memberId: admin.id } }))?.balance ?? 0).toBe(
      0,
    );
  });

  it("sets a salary without letting the body change role, status or wallet", async () => {
    const coop = await createTestCoop("MASS2");
    const { app, cookie } = await adminSession(coop.id, "2348070000002");
    const target = await createTestMember(coop.id, {
      phone: "2348070000003",
      role: "superadmin",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/payroll/set",
      headers: { cookie, "x-requested-with": "XMLHttpRequest" },
      payload: { memberCode: target.code, amount: 50_000, ...PRIVILEGED },
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
