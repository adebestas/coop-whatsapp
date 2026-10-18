import { describe, it, expect } from "vitest";
import { prisma } from "./setup.js";
import { provisionCooperative, addCoopAdmin } from "../src/services/cooperative-provisioning.js";

describe("provisioning", () => {
  it("creates a coop with config, branding, subscription and a super-admin", async () => {
    const out = await provisionCooperative({
      name: "Ado Coop",
      code: `ADO${Date.now()}`,
      state: "Ekiti",
      adminPhone: "2348011111111",
      adminName: "Ada",
    });
    const coop = await prisma.cooperative.findUnique({
      where: { id: out.cooperativeId },
      include: { config: true, branding: true, subscription: true },
    });
    expect(coop?.config).toBeTruthy();
    expect(coop?.branding).toBeTruthy();
    expect(coop?.subscription).toBeTruthy();
    const admin = await prisma.member.findFirst({
      where: { cooperativeId: out.cooperativeId, role: "superadmin" },
    });
    expect(admin?.phone).toBe("2348011111111");
  });
  it("adds an admin to an existing coop", async () => {
    const out = await provisionCooperative({
      name: "B Coop",
      code: `B${Date.now()}`,
      adminPhone: "2348022222222",
    });
    const added = await addCoopAdmin(out.cooperativeId, { phone: "2348033333333", role: "admin" });
    expect(added.created).toBe(true);
    const m = await prisma.member.findUnique({ where: { id: added.memberId } });
    expect(m?.role).toBe("admin");
  });
});
