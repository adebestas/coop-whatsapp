import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanupDatabase } from "../tests/setup.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { escalateOverdueSTRs, STR_ESCALATION_REPEAT_MS } from "../src/services/aml.js";
import { notifyMember } from "../src/lib/messaging.js";

// tests/setup.ts already wraps messaging.js in vi.fn() and mocks the transport
// (src/lib/whatsapp.js, src/lib/telegram.js). A per-file mock of messaging.js
// would be inert — the setup mock is registered first — so assert on the spy
// that aml.ts actually calls through.
const notifySpy = vi.mocked(notifyMember);

async function makeCoop(code: string) {
  return prisma.cooperative.create({ data: { name: "STR Coop", code } });
}

async function makeMember(phone: string, coopId: string, role = "member") {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) code = generateMemberCode();
  return prisma.member.create({
    data: {
      code,
      phone,
      name: `Member ${phone.slice(-4)}`,
      cooperativeId: coopId,
      role,
      pin: hashPin("1234"),
      wallet: { create: {} },
    },
  });
}

async function makeOverdueStr(coopId: string, memberId: string) {
  return prisma.sTR.create({
    data: {
      cooperativeId: coopId,
      memberId,
      amount: 6_000_000,
      reason: "large cash movement",
      status: "pending",
      // 100 hours ago -> well past the 72h CBN filing window
      createdAt: new Date(Date.now() - 100 * 60 * 60 * 1000),
    },
  });
}

beforeEach(async () => {
  await cleanupDatabase();
  vi.clearAllMocks();
});

describe("STR 72h filing-deadline escalation", () => {
  it("alerts super admins for a pending STR past the 72h deadline", async () => {
    const coop = await makeCoop("STRESC1");
    const admin = await makeMember("2348022000001", coop.id, "superadmin");
    const subject = await makeMember("2348022000002", coop.id);
    const str = await makeOverdueStr(coop.id, subject.id);

    expect(await escalateOverdueSTRs()).toBe(1);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0][0].phone).toBe(admin.phone);

    // The claim must be persisted so it survives a restart.
    const after = await prisma.sTR.findUniqueOrThrow({ where: { id: str.id } });
    expect(after.escalatedAt).not.toBeNull();
  });

  it("does NOT re-alert on subsequent scheduler ticks (idempotence)", async () => {
    const coop = await makeCoop("STRESC2");
    await makeMember("2348022000003", coop.id, "superadmin");
    const subject = await makeMember("2348022000004", coop.id);
    await makeOverdueStr(coop.id, subject.id);

    // First tick alerts.
    expect(await escalateOverdueSTRs()).toBe(1);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    // Production runs this every 15 minutes - it must stay silent after that.
    expect(await escalateOverdueSTRs()).toBe(0);
    expect(await escalateOverdueSTRs()).toBe(0);
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it("ignores STRs still inside the 72h window", async () => {
    const coop = await makeCoop("STRESC3");
    await makeMember("2348022000005", coop.id, "superadmin");
    const subject = await makeMember("2348022000006", coop.id);

    await prisma.sTR.create({
      data: {
        cooperativeId: coop.id,
        memberId: subject.id,
        amount: 6_000_000,
        reason: "still fresh",
        status: "pending",
        createdAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
      },
    });

    expect(await escalateOverdueSTRs()).toBe(0);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("ignores STRs that have already been filed", async () => {
    const coop = await makeCoop("STRESC4");
    await makeMember("2348022000007", coop.id, "superadmin");
    const subject = await makeMember("2348022000008", coop.id);

    await prisma.sTR.create({
      data: {
        cooperativeId: coop.id,
        memberId: subject.id,
        amount: 6_000_000,
        reason: "already filed",
        status: "filed",
        filedAt: new Date(),
        createdAt: new Date(Date.now() - 100 * 60 * 60 * 1000),
      },
    });

    expect(await escalateOverdueSTRs()).toBe(0);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("alerts again once the 24h suppression window lapses", async () => {
    const coop = await makeCoop("STRESC5");
    await makeMember("2348022000009", coop.id, "superadmin");
    const subject = await makeMember("2348022000010", coop.id);
    const str = await makeOverdueStr(coop.id, subject.id);

    expect(await escalateOverdueSTRs()).toBe(1);
    expect(notifySpy).toHaveBeenCalledTimes(1);

    // Wind the clock past the suppression window rather than touching Redis.
    const later = new Date(Date.now() + STR_ESCALATION_REPEAT_MS + 60_000);
    expect(await escalateOverdueSTRs(later)).toBe(1);
    expect(notifySpy).toHaveBeenCalledTimes(2);

    const after = await prisma.sTR.findUniqueOrThrow({ where: { id: str.id } });
    expect(after.escalatedAt?.getTime()).toBeGreaterThanOrEqual(later.getTime() - 1000);
  });
});
