import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { clearMemberCache } from "../src/services/cooperative.js";
import { handleAdminCommand } from "../src/services/admin.js";

beforeEach(async () => {
  vi.clearAllMocks();
  clearMemberCache();
  await cleanupDatabase();
});

afterAll(cleanupDatabase);

describe("federation admin commands", () => {
  it("creates a federation and adds a coop", async () => {
    const coop = await createTestCoop("FEDC1");
    const admin = await createTestMember(coop.id, { phone: "2348000090001", role: "superadmin" });

    await handleAdminCommand(admin.phone, "federation", ["create", "WestAfrica", "NGN"]);
    const fed = await prisma.federation.findFirst({ where: { name: "WestAfrica" } });
    expect(fed).toBeTruthy();
    expect(fed?.baseCurrency).toBe("NGN");

    await handleAdminCommand(admin.phone, "federation", ["addcoop", coop.code]);
    const membership = await prisma.federationMembership.findFirst({
      where: { federationId: fed!.id, cooperativeId: coop.id },
    });
    expect(membership).toBeTruthy();
    expect(membership?.status).toBe("active");
  });

  it("sets an FX rate", async () => {
    const coop = await createTestCoop("FEDC2");
    const admin = await createTestMember(coop.id, { phone: "2348000090011", role: "superadmin" });

    await handleAdminCommand(admin.phone, "federation", ["create", "EcoFed", "NGN"]);
    await handleAdminCommand(admin.phone, "federation", ["rate", "NGN", "GHS", "0.008"]);

    const rate = await prisma.fxRate.findFirst({
      where: { baseCurrency: "NGN", quoteCurrency: "GHS" },
    });
    expect(rate).toBeTruthy();
    expect(rate?.rate).toBeCloseTo(0.008);
  });
});
