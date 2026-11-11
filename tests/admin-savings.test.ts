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

async function seedProduct(coopId: string, adminId: string, name = "Fixed 12m") {
  return prisma.savingsProduct.create({
    data: {
      cooperativeId: coopId,
      type: "fixed",
      name,
      interestRate: 8,
      termMonths: 12,
      minAmount: 100000,
      createdById: adminId,
    },
  });
}

describe("admin savings products", () => {
  it("lists products with account counts and balances for the admin's cooperative only", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("SAV1");
    const admin = await createTestMember(coop.id, {
      role: "superadmin",
      phone: "2348091000001",
      pin: "1234",
    });
    const product = await seedProduct(coop.id, admin.id);
    const member = await createTestMember(coop.id, { phone: "2348091000002" });
    await prisma.savingsAccount.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        productId: product.id,
        balance: 250000,
        status: "active",
      },
    });

    const otherCoop = await createTestCoop("SAV2");
    const otherAdmin = await createTestMember(otherCoop.id, { phone: "2348091000003" });
    await seedProduct(otherCoop.id, otherAdmin.id, "Other product");

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/savings/products",
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.products).toHaveLength(1);
    expect(body.products[0]).toMatchObject({
      id: product.id,
      name: "Fixed 12m",
      type: "fixed",
      accountCount: 1,
      totalBalance: 250000,
    });
  });

  it("lets a super admin create a product and audits the change", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("SAV3");
    const admin = await createTestMember(coop.id, {
      role: "superadmin",
      phone: "2348091000011",
      pin: "1234",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/savings/products",
      headers: {
        cookie: await loginAs(app, admin.phone),
        "x-requested-with": "XMLHttpRequest",
      },
      payload: { type: "goal", name: "School fees", minAmount: 50000 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().productId).toBeTruthy();
    const created = await prisma.savingsProduct.findFirst({
      where: { cooperativeId: coop.id, name: "School fees" },
    });
    expect(created).toBeTruthy();
    expect(created?.type).toBe("goal");

    const auditRow = await prisma.auditLog.findFirst({
      where: { cooperativeId: coop.id, action: "savings.product_create" },
    });
    expect(auditRow).toBeTruthy();
  });

  it("refuses a non-super admin from creating a product", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("SAV4");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348091000021",
      pin: "1234",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/savings/products",
      headers: {
        cookie: await loginAs(app, admin.phone),
        "x-requested-with": "XMLHttpRequest",
      },
      payload: { type: "goal", name: "Nope" },
    });

    expect(res.statusCode).toBe(403);
    expect(await prisma.savingsProduct.count({ where: { cooperativeId: coop.id } })).toBe(0);
  });

  it("rejects an unknown product type", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("SAV5");
    const admin = await createTestMember(coop.id, {
      role: "superadmin",
      phone: "2348091000031",
      pin: "1234",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/savings/products",
      headers: {
        cookie: await loginAs(app, admin.phone),
        "x-requested-with": "XMLHttpRequest",
      },
      payload: { type: "crypto", name: "Moon" },
    });

    expect(res.statusCode).toBe(400);
    expect(await prisma.savingsProduct.count({ where: { cooperativeId: coop.id } })).toBe(0);
  });

  it("toggles a product's active flag", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("SAV6");
    const admin = await createTestMember(coop.id, {
      role: "superadmin",
      phone: "2348091000041",
      pin: "1234",
    });
    const product = await seedProduct(coop.id, admin.id);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/savings/products/${product.id}`,
      headers: {
        cookie: await loginAs(app, admin.phone),
        "x-requested-with": "XMLHttpRequest",
      },
      payload: { active: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().product.active).toBe(false);
    const updated = await prisma.savingsProduct.findUnique({ where: { id: product.id } });
    expect(updated?.active).toBe(false);
  });
});

describe("admin savings accounts", () => {
  it("lists accounts with member and product details, scoped to the cooperative", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("SACC1");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348091000051",
      pin: "1234",
    });
    const product = await seedProduct(coop.id, admin.id);
    const member = await createTestMember(coop.id, { phone: "2348091000052", name: "Ada Obi" });
    await prisma.savingsAccount.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        productId: product.id,
        balance: 120000,
        targetAmount: 500000,
        status: "active",
      },
    });

    const otherCoop = await createTestCoop("SACC2");
    const otherAdmin = await createTestMember(otherCoop.id, { phone: "2348091000053" });
    const otherProduct = await seedProduct(otherCoop.id, otherAdmin.id, "Elsewhere");
    const otherMember = await createTestMember(otherCoop.id, { phone: "2348091000054" });
    await prisma.savingsAccount.create({
      data: {
        cooperativeId: otherCoop.id,
        memberId: otherMember.id,
        productId: otherProduct.id,
        balance: 999999,
        status: "active",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/savings/accounts",
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({
      memberName: "Ada Obi",
      productName: "Fixed 12m",
      balance: 120000,
      targetAmount: 500000,
      status: "active",
    });
    expect(body.totals).toMatchObject({ accounts: 1, balance: 120000 });
  });

  it("opens a savings account for a member (super admin)", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("SACC3");
    const admin = await createTestMember(coop.id, {
      role: "superadmin",
      phone: "2348091000061",
      pin: "1234",
    });
    const product = await seedProduct(coop.id, admin.id);
    const member = await createTestMember(coop.id, { phone: "2348091000062" });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/savings/accounts",
      headers: {
        cookie: await loginAs(app, admin.phone),
        "x-requested-with": "XMLHttpRequest",
      },
      payload: { memberId: member.id, productId: product.id, targetAmount: 300000 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().accountId).toBeTruthy();
    const account = await prisma.savingsAccount.findFirst({
      where: { cooperativeId: coop.id, memberId: member.id, productId: product.id },
    });
    expect(account?.targetAmount).toBe(300000);
  });
});
