import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./setup.js";
import { audit, verifyAuditChain } from "../src/services/audit.js";
import { runWithRequestContext } from "../src/lib/request-context.js";
import {
  evaluateLoginAnomalies,
  STUFFING_DISTINCT_ACCOUNTS,
  RECOVERY_FAILURES,
} from "../src/lib/login-anomaly.js";
import { claimOnce } from "../src/lib/cache.js";

async function makeCoop(code: string) {
  return prisma.cooperative.upsert({
    where: { code },
    create: { code, name: `Test ${code}`, state: "Lagos", adminPhone: "2348012345678" },
    update: {},
  });
}

async function attempt(data: {
  surface?: string;
  phone: string;
  ip: string;
  outcome: string;
  createdAt?: Date;
}) {
  return prisma.loginAttempt.create({
    data: {
      surface: data.surface ?? "dashboard_admin",
      phone: data.phone,
      ip: data.ip,
      outcome: data.outcome,
      createdAt: data.createdAt,
    },
  });
}

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.platformAuditLog.deleteMany();
  await prisma.loginAttempt.deleteMany();
  await prisma.loginLock.deleteMany();
});

afterAll(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.platformAuditLog.deleteMany();
  await prisma.loginAttempt.deleteMany();
  await prisma.loginLock.deleteMany();
  await prisma.cooperative.deleteMany();
});

describe("audit request context", () => {
  it("stores ip, user agent and request id without breaking the hash chain", async () => {
    const coop = await makeCoop("CTXA");
    await runWithRequestContext(
      { ip: "203.0.113.9", userAgent: "Mozilla/5.0 (Test)", requestId: "req-test-1" },
      () => audit({ cooperativeId: coop.id, actorPhone: "08030000001", action: "member.update" }),
    );
    await runWithRequestContext({ ip: "203.0.113.9", userAgent: "Mozilla/5.0 (Test)" }, () =>
      audit({ cooperativeId: coop.id, actorPhone: "08030000001", action: "member.update" }),
    );

    const rows = await prisma.auditLog.findMany({
      where: { cooperativeId: coop.id },
      orderBy: { seq: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].ip).toBe("203.0.113.9");
    expect(rows[0].userAgent).toBe("Mozilla/5.0 (Test)");
    expect(rows[0].errorId).toBe("req-test-1");
    expect(rows[1].errorId).toBeNull();
    expect(await verifyAuditChain(coop.id)).toEqual({ ok: true, checked: 2 });
  });

  it("records nothing extra when there is no request context", async () => {
    const coop = await makeCoop("CTXB");
    await audit({ cooperativeId: coop.id, actorPhone: "08030000002", action: "loan.approve" });
    const row = await prisma.auditLog.findFirst({ where: { cooperativeId: coop.id } });
    expect(row?.ip).toBeNull();
    expect(row?.userAgent).toBeNull();
    expect(row?.errorId).toBeNull();
  });
});

describe("login anomaly rules", () => {
  it("flags the first successful sign-in from a new IP", async () => {
    const phone = "08031110001";
    await attempt({
      phone,
      ip: "198.51.100.1",
      outcome: "success",
      createdAt: new Date(Date.now() - 2 * 86400_000),
    });
    await attempt({ phone, ip: "198.51.100.2", outcome: "success" });

    const findings = await evaluateLoginAnomalies({
      surface: "dashboard_admin",
      phone,
      ip: "198.51.100.2",
    });
    expect(findings.map((f) => f.rule)).toContain("new_ip");
    const key = `new_ip:dashboard_admin:${phone}:198.51.100.2`;
    expect(await claimOnce("login-anomaly", key, 900)).toBe(false);
  });

  it("does not flag an IP the account has used in the last 30 days", async () => {
    const phone = "08031110002";
    await attempt({
      phone,
      ip: "198.51.100.3",
      outcome: "success",
      createdAt: new Date(Date.now() - 86400_000),
    });
    await attempt({ phone, ip: "198.51.100.3", outcome: "success" });
    const findings = await evaluateLoginAnomalies({
      surface: "dashboard_admin",
      phone,
      ip: "198.51.100.3",
    });
    expect(findings.map((f) => f.rule)).not.toContain("new_ip");
  });

  it("flags one IP failing across many accounts", async () => {
    const ip = "198.51.100.4";
    for (let i = 0; i < STUFFING_DISTINCT_ACCOUNTS; i += 1) {
      await attempt({ phone: `0803112000${i}`, ip, outcome: "bad_credentials" });
    }
    await attempt({ phone: "08031129999", ip, outcome: "success" });
    const findings = await evaluateLoginAnomalies({
      surface: "dashboard_admin",
      phone: "08031129999",
      ip,
    });
    expect(findings.map((f) => f.rule)).toContain("credential_stuffing");
  });

  it("flags a success that follows repeated failures", async () => {
    const phone = "08031130001";
    const ip = "198.51.100.5";
    for (let i = 0; i < RECOVERY_FAILURES; i += 1) {
      await attempt({ phone, ip, outcome: i % 2 === 0 ? "bad_credentials" : "totp_failed" });
    }
    await attempt({ phone, ip, outcome: "success" });
    const findings = await evaluateLoginAnomalies({ surface: "dashboard_admin", phone, ip });
    expect(findings.map((f) => f.rule)).toContain("recovery_after_failures");
  });
});
