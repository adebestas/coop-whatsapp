import { describe, it, expect } from "vitest";
import { prisma } from "./setup.js";

describe("platform schema", () => {
  it("creates a PlatformAdmin with a platform role", async () => {
    const a = await prisma.platformAdmin.create({
      data: { name: "Owner", phone: "2348000000001", role: "owner", pin: "x:y" },
    });
    expect(a.id).toBeTruthy();
    expect(a.role).toBe("owner");
  });
  it("creates a PlatformPolicy row keyed by rule", async () => {
    const p = await prisma.platformPolicy.create({
      data: { key: "loanInterestRate", value: "10", min: 1, max: 60, locked: false },
    });
    expect(p.key).toBe("loanInterestRate");
  });
  it("stores a Cooperative.tokensValidAfter timestamp", async () => {
    const c = await prisma.cooperative.create({
      data: { name: "T", code: "PTEST1", tokensValidAfter: new Date() },
    });
    expect(c.tokensValidAfter).toBeInstanceOf(Date);
  });
  it("has the new loan-term config columns", async () => {
    const c = await prisma.cooperative.create({ data: { name: "T2", code: "PTEST2" } });
    const cfg = await prisma.cooperativeConfig.create({
      data: { cooperativeId: c.id, loanDurationMonths: 12, minMembershipMonths: 0 },
    });
    expect(cfg.loanDurationMonths).toBe(12);
  });
  it("writes a platform audit row via the writer", async () => {
    const { writePlatformAudit } = await import("../src/services/platform-audit.js");
    await writePlatformAudit({
      actorId: "pa1",
      actorPhone: "2348000000001",
      actorRole: "owner",
      action: "coop.create",
      cooperativeId: "c1",
      targetType: "Cooperative",
      targetId: "c1",
      detail: "{}",
    });
    const rows = await prisma.platformAuditLog.findMany({ where: { action: "coop.create" } });
    expect(rows.length).toBe(1);
    expect(rows[0].actorRole).toBe("owner");
  });
});
