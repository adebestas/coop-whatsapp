/**
 * OPS-5: retention & right-to-erasure.
 *
 *  - The 7-year retention job must actually anonymize PII for non-operational
 *    members. It previously filtered on `status: "inactive"` — a value the app
 *    never assigns — so it silently anonymized nobody (a dead job).
 *  - Self-service account deletion must clear the member's session (whose
 *    `data` JSON can hold mid-flow PII) and leave an audit entry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanupDatabase } from "./setup.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { runDataRetention } from "../src/services/scheduler.js";
import { handleDeleteAccountPin } from "../src/services/handlers/admin-actions.js";

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: `Retention Coop ${code}`, code } });
}

async function makeMember(
  coopId: string,
  opts: { status?: string; createdAt?: Date; phone?: string } = {},
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  return prisma.member.create({
    data: {
      code,
      phone: opts.phone ?? `2348${Math.floor(10_000_000_000 + Math.random() * 89_999_999_999)}`,
      name: `Retention Member ${code}`,
      cooperativeId: coopId,
      role: "member",
      status: opts.status ?? "active",
      pin: hashPin("1234"),
      contactPhone: "2348011111111",
      nextOfKinName: "Next Kin",
      nextOfKinPhone: "2348022222222",
      dateOfBirth: new Date("1990-05-05T00:00:00.000Z"),
      createdAt: opts.createdAt,
      wallet: { create: {} },
    },
  });
}

// The retention job only runs on the 1st of the month; 7 years back = 2019-06-01.
const JOB_NOW = new Date("2026-06-01T12:00:00.000Z");
const EIGHT_YEARS_AGO = new Date("2017-01-15T00:00:00.000Z");
const RECENT = new Date("2024-03-01T00:00:00.000Z");

beforeEach(async () => {
  await cleanupDatabase();
  vi.clearAllMocks();
});

describe("7-year PII retention", () => {
  it("anonymizes only old non-operational members (suspended/deceased)", async () => {
    const coop = await makeCoop("RET01");
    const suspendedOld = await makeMember(coop.id, {
      status: "suspended",
      createdAt: EIGHT_YEARS_AGO,
    });
    const deceasedOld = await makeMember(coop.id, {
      status: "deceased",
      createdAt: EIGHT_YEARS_AGO,
    });
    const activeOld = await makeMember(coop.id, { status: "active", createdAt: EIGHT_YEARS_AGO });
    const suspendedRecent = await makeMember(coop.id, {
      status: "suspended",
      createdAt: RECENT,
    });

    const result = await runDataRetention(JOB_NOW);
    expect(result.anonymized).toBe(2);

    const redacted = await prisma.member.findUniqueOrThrow({ where: { id: suspendedOld.id } });
    expect(redacted.name).toBe(`Redacted_${suspendedOld.id.slice(-6)}`);
    expect(redacted.phone).toBe(`redacted_${suspendedOld.id.slice(-6)}`);
    expect(redacted.contactPhone).toBeNull();
    expect(redacted.nextOfKinName).toBeNull();
    expect(redacted.nextOfKinPhone).toBeNull();
    expect(redacted.dateOfBirth).toBeNull();

    const deceased = await prisma.member.findUniqueOrThrow({ where: { id: deceasedOld.id } });
    expect(deceased.name).toBe(`Redacted_${deceasedOld.id.slice(-6)}`);

    // Active members are never touched, no matter how old.
    const active = await prisma.member.findUniqueOrThrow({ where: { id: activeOld.id } });
    expect(active.name).toBe(activeOld.name);
    expect(active.contactPhone).toBe("2348011111111");

    // Recently-closed members are still within the window.
    const recent = await prisma.member.findUniqueOrThrow({ where: { id: suspendedRecent.id } });
    expect(recent.name).toBe(suspendedRecent.name);
  });

  it("purges sessions older than 30 days but keeps recent ones", async () => {
    await makeCoop("RET02");
    const oldSession = await prisma.session.create({
      data: { phone: "2348099990001", updatedAt: new Date("2026-04-01T00:00:00.000Z") },
    });
    const freshSession = await prisma.session.create({ data: { phone: "2348099990002" } });

    const result = await runDataRetention(JOB_NOW);
    expect(result.deleted).toBe(1);

    expect(await prisma.session.findUnique({ where: { id: oldSession.id } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { id: freshSession.id } })).not.toBeNull();
  });
});

describe("self-service account erasure", () => {
  it("erases PII, clears the member's session, and writes an audit entry", async () => {
    const coop = await makeCoop("RET03");
    const phone = "2348033334444";
    const member = await makeMember(coop.id, { phone });

    // An in-flight session for this phone holding mid-flow PII.
    await prisma.session.create({
      data: { phone, state: "awaiting_name", data: JSON.stringify({ name: "Ada" }) },
    });

    await handleDeleteAccountPin(phone, "1234", coop.id);

    const updated = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(updated.name).toBe("Deleted Member");
    expect(updated.phone).toBe(`deleted:${member.id}`);
    expect(updated.bankAccountNumber).toBeNull();
    expect(updated.nextOfKinName).toBeNull();

    // The session (which could carry PII) is gone.
    expect(await prisma.session.findUnique({ where: { phone } })).toBeNull();

    // The erasure is traceable in the audit trail.
    const audits = await prisma.auditLog.findMany({ where: { action: "member.data_erasure" } });
    expect(audits).toHaveLength(1);
    expect(audits[0].targetId).toBe(member.id);
    expect(audits[0].cooperativeId).toBe(coop.id);

    // The deletion consent is recorded as GRANTED (the member asked for it),
    // not falsely as a decline.
    const consent = await prisma.dataConsent.findFirst({
      where: { memberId: member.id, consentType: "delete_account" },
    });
    expect(consent?.granted).toBe(true);
  });

  it("refuses to erase when the PIN is wrong", async () => {
    const coop = await makeCoop("RET04");
    const phone = "2348033335555";
    const member = await makeMember(coop.id, { phone });

    await handleDeleteAccountPin(phone, "9999", coop.id);

    const unchanged = await prisma.member.findUniqueOrThrow({ where: { id: member.id } });
    expect(unchanged.name).toBe(member.name);
    expect(await prisma.auditLog.count({ where: { action: "member.data_erasure" } })).toBe(0);
  });
});
