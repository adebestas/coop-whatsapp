import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "./setup.js";
import { buildApp } from "../src/app.js";
import { hashPin } from "../src/lib/security.js";
process.env.ADMIN_JWT_SECRET ||= "test-platform-secret-0123456789";
const app = buildApp();
let cookie: string;
beforeEach(async () => {
  await prisma.platformAdmin.deleteMany();
  await prisma.platformAdmin.create({ data: { name: "O", phone: "2348000000001", role: "owner", pin: hashPin("123456"), mustChangePin: false } });
  const r = await app.inject({ method: "POST", url: "/api/developer/login", payload: { phone: "2348000000001", pin: "123456" } });
  cookie = (r.headers["set-cookie"] as string).split(";")[0];
});
const mut = (url: string, payload: any) => app.inject({ method: "POST", url, payload, headers: { cookie, "x-requested-with": "xmlhttprequest" } });

describe("platform provisioning routes", () => {
  it("creates a coop with its first super-admin", async () => {
    const res = await mut("/api/developer/coops", { name: "Lagos Coop", code: `LG${Date.now()}`, state: "Lagos", superAdmin: { name: "Ada", phone: "2348111111111" } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const admin = await prisma.member.findFirst({ where: { cooperativeId: body.cooperativeId, role: "superadmin" } });
    expect(admin?.phone).toBe("2348111111111");
  });
  it("adds an admin to an existing coop", async () => {
    const created = await mut("/api/developer/coops", { name: "X", code: `X${Date.now()}`, superAdmin: { name: "S", phone: "2348222222222" } });
    const id = JSON.parse(created.body).cooperativeId;
    const res = await mut(`/api/developer/coops/${id}/admins`, { phone: "2348333333333", role: "admin" });
    expect(res.statusCode).toBe(200);
  });
  it("requires the CSRF header on mutations", async () => {
    const res = await app.inject({ method: "POST", url: "/api/developer/coops", payload: {}, headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });
});
