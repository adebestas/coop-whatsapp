import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import {
  escalateCase,
  listCases,
  getCase,
  isOmbudsman,
  investigateCase,
  decideCase,
} from "../src/services/ombudsman.js";
import { runOmbudsmanEscalations } from "../src/services/scheduler.js";
import { sendText, notifyMember } from "../src/lib/messaging.js";
import { clearMemberCache } from "../src/services/cooperative.js";
import { handleMessage } from "../src/services/conversation.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function createGrievance(coopId: string, memberId: string, message = "Loan rejected unfairly") {
  return prisma.grievance.create({ data: { cooperativeId: coopId, memberId, message } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearMemberCache();
  await cleanupDatabase();
});

afterAll(cleanupDatabase);

describe("ombudsman escalation", () => {
  it("creates an open case with an escalated event and the coop's SLA", async () => {
    const coop = await createTestCoop("OMB1");
    const member = await createTestMember(coop.id, { phone: "2348000040001" });
    await prisma.cooperativeConfig.create({
      data: { cooperativeId: coop.id, ombudsmanSlaDays: 10 },
    });
    const g = await createGrievance(coop.id, member.id);

    const before = Date.now();
    const res = await escalateCase(
      coop.id,
      member.id,
      {
        sourceType: "grievance",
        sourceId: g.id,
        category: "loan_rejection",
        summary: "Loan was rejected without reason",
      },
      { id: member.id, phone: member.phone },
    );
    expect(res.ok).toBe(true);
    expect(res.caseId).toBeTruthy();

    const c = await prisma.ombudsmanCase.findUnique({
      where: { id: res.caseId! },
      include: { events: true },
    });
    expect(c).toBeTruthy();
    expect(c!.escalatedBy).toBe("member");
    expect(c!.status).toBe("open");
    expect(c!.category).toBe("loan_rejection");
    expect(c!.sourceId).toBe(g.id);
    expect(c!.slaDueAt).toBeInstanceOf(Date);
    expect(Math.abs(c!.slaDueAt!.getTime() - (before + 10 * DAY_MS))).toBeLessThan(60_000);
    expect(c!.events).toHaveLength(1);
    expect(c!.events[0].action).toBe("escalated");
    expect(c!.events[0].actorRole).toBe("member");
  });

  it("refuses to escalate the same source twice", async () => {
    const coop = await createTestCoop("OMB2");
    const member = await createTestMember(coop.id, { phone: "2348000040011" });
    const g = await createGrievance(coop.id, member.id);
    const actor = { id: member.id, phone: member.phone };
    const input = {
      sourceType: "grievance" as const,
      sourceId: g.id,
      category: "other",
      summary: "Duplicate",
    };

    const first = await escalateCase(coop.id, member.id, input, actor);
    const second = await escalateCase(coop.id, member.id, input, actor);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/already/i);
    expect(await prisma.ombudsmanCase.count({ where: { sourceId: g.id } })).toBe(1);
  });

  it("enforces one case per source at the database level (partial unique index)", async () => {
    const coop = await createTestCoop("OMB6");
    const member = await createTestMember(coop.id, { phone: "2348000040051" });
    const g = await createGrievance(coop.id, member.id);
    const base = {
      cooperativeId: coop.id,
      memberId: member.id,
      sourceType: "grievance",
      sourceId: g.id,
      category: "other",
      summary: "first",
      escalatedBy: "member",
    };
    await prisma.ombudsmanCase.create({ data: base });

    await expect(
      prisma.ombudsmanCase.create({ data: { ...base, summary: "second" } }),
    ).rejects.toMatchObject({ code: "P2002" });

    // Sourceless disputes are not constrained by the partial index.
    const dispute = {
      cooperativeId: coop.id,
      memberId: member.id,
      sourceType: "dispute",
      sourceId: null,
      category: "other",
      summary: "a",
      escalatedBy: "member",
    };
    await prisma.ombudsmanCase.create({ data: dispute });
    await expect(prisma.ombudsmanCase.create({ data: { ...dispute, summary: "b" } })).resolves.toBeTruthy();
  });

  it("notifies active ombudsmen and ignores inactive ones", async () => {
    const coop = await createTestCoop("OMB3");
    const member = await createTestMember(coop.id, { phone: "2348000040021" });
    await prisma.ombudsman.create({
      data: { name: "Ada Ombuds", phone: "2348000049999", active: true },
    });
    await prisma.ombudsman.create({
      data: { name: "Retired", phone: "2348000048888", active: false },
    });
    const g = await createGrievance(coop.id, member.id);

    await escalateCase(
      coop.id,
      member.id,
      { sourceType: "grievance", sourceId: g.id, category: "freeze", summary: "Frozen wrongly" },
      { id: member.id, phone: member.phone },
    );

    const recipients = vi
      .mocked(sendText)
      .mock.calls.map((c) => c[0].to)
      .join("\n");
    expect(recipients).toContain("2348000049999");
    expect(recipients).not.toContain("2348000048888");
  });

  it("lists open cases and returns a case timeline", async () => {
    const coop = await createTestCoop("OMB4");
    const member = await createTestMember(coop.id, { phone: "2348000040031" });
    const g = await createGrievance(coop.id, member.id);

    const res = await escalateCase(
      coop.id,
      member.id,
      { sourceType: "grievance", sourceId: g.id, category: "other", summary: "Timeline check" },
      { id: member.id, phone: member.phone },
    );

    const listed = await listCases("open");
    expect(listed.ok).toBe(true);
    expect(listed.cases?.some((c) => c.id === res.caseId)).toBe(true);

    const detail = await getCase(res.caseId!);
    expect(detail.ok).toBe(true);
    expect(detail.case?.id).toBe(res.caseId);
    expect(detail.case?.events.length).toBeGreaterThanOrEqual(1);
    expect(detail.case?.events[0].action).toBe("escalated");
  });

  it("refuses an ambiguous case id instead of returning an arbitrary timeline", async () => {
    const coop = await createTestCoop("OMB7");
    const member = await createTestMember(coop.id, { phone: "2348000040061" });
    const common = {
      cooperativeId: coop.id,
      memberId: member.id,
      sourceType: "dispute",
      sourceId: null,
      category: "other",
      escalatedBy: "member",
    };
    await prisma.ombudsmanCase.create({
      data: { ...common, id: "abcdef0000000000000001", summary: "one" },
    });
    await prisma.ombudsmanCase.create({
      data: { ...common, id: "abcdef0000000000000002", summary: "two" },
    });

    const exact = await getCase("abcdef0000000000000001");
    expect(exact.ok).toBe(true);
    expect(exact.case?.id).toBe("abcdef0000000000000001");

    const ambiguous = await getCase("abcdef");
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.message).toMatch(/more than one|more characters/i);

    const tooShort = await getCase("abc");
    expect(tooShort.ok).toBe(false);
  });

  it("recognises only an active ombudsman phone", async () => {
    await prisma.ombudsman.create({
      data: { name: "Ada Ombuds", phone: "2348000047777", active: true },
    });
    await prisma.ombudsman.create({
      data: { name: "Retired", phone: "2348000046666", active: false },
    });

    expect(await isOmbudsman("2348000047777")).toBe(true);
    expect(await isOmbudsman("2348000046666")).toBe(false);
    expect(await isOmbudsman("2348000000000")).toBe(false);
  });
});

describe("auto-SLA escalation", () => {
  it("auto-escalates a grievance open past the SLA exactly once", async () => {
    const coop = await createTestCoop("OMB8");
    const member = await createTestMember(coop.id, { phone: "2348000040071" });
    await prisma.cooperativeConfig.create({
      data: { cooperativeId: coop.id, ombudsmanSlaDays: 7 },
    });
    const g = await prisma.grievance.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        message: "Ignored for weeks",
        createdAt: new Date(Date.now() - 10 * DAY_MS),
      },
    });

    const count = await runOmbudsmanEscalations(new Date());
    expect(count).toBe(1);

    const c = await prisma.ombudsmanCase.findFirst({ where: { sourceId: g.id } });
    expect(c).toBeTruthy();
    expect(c!.escalatedBy).toBe("auto");
    expect(c!.status).toBe("open");
    expect(c!.sourceType).toBe("grievance");
    expect(c!.memberId).toBe(member.id);
    expect(await prisma.ombudsmanCaseEvent.count({ where: { caseId: c!.id } })).toBe(1);

    // Second tick is idempotent — the unique source index blocks a duplicate.
    const again = await runOmbudsmanEscalations(new Date());
    expect(again).toBe(0);
    expect(await prisma.ombudsmanCase.count({ where: { sourceId: g.id } })).toBe(1);
  });

  it("does not escalate a grievance within the SLA", async () => {
    const coop = await createTestCoop("OMB9");
    const member = await createTestMember(coop.id, { phone: "2348000040081" });
    await prisma.cooperativeConfig.create({
      data: { cooperativeId: coop.id, ombudsmanSlaDays: 7 },
    });
    const g = await prisma.grievance.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        message: "Still fresh",
        createdAt: new Date(Date.now() - 2 * DAY_MS),
      },
    });

    const count = await runOmbudsmanEscalations(new Date());
    expect(count).toBe(0);
    expect(await prisma.ombudsmanCase.count({ where: { sourceId: g.id } })).toBe(0);
  });

  it("a second tick over an already-escalated grievance creates no case and does not error", async () => {
    const coop = await createTestCoop("OMB10");
    const member = await createTestMember(coop.id, { phone: "2348000040091" });
    await prisma.cooperativeConfig.create({
      data: { cooperativeId: coop.id, ombudsmanSlaDays: 7 },
    });
    const g = await prisma.grievance.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        message: "Case already open",
        createdAt: new Date(Date.now() - 10 * DAY_MS),
      },
    });
    // A case already exists for this source (e.g. a prior tick).
    await prisma.ombudsmanCase.create({
      data: {
        cooperativeId: coop.id,
        memberId: member.id,
        sourceType: "grievance",
        sourceId: g.id,
        category: "other",
        summary: "Case already open",
        status: "open",
        escalatedBy: "auto",
      },
    });

    const count = await runOmbudsmanEscalations(new Date());
    expect(count).toBe(0);
    expect(await prisma.ombudsmanCase.count({ where: { sourceId: g.id } })).toBe(1);
  });
});

describe("member escalate command", () => {
  it("escalates a grievance through the chat command", async () => {
    const coop = await createTestCoop("OMB5");
    const member = await createTestMember(coop.id, { phone: "2348000040041" });
    const g = await createGrievance(coop.id, member.id);

    await handleMessage(member.phone, `escalate ${g.id} still no response`);
    const c = await prisma.ombudsmanCase.findFirst({ where: { memberId: member.id } });
    expect(c).toBeTruthy();
    expect(c!.sourceId).toBe(g.id);
    expect(c!.escalatedBy).toBe("member");

    const texts = vi
      .mocked(sendText)
      .mock.calls.map((c) => c[0].text)
      .join("\n");
    expect(texts).toMatch(/ombudsman/i);
  });
});

describe("ombudsman decisions", () => {
  async function seedEscalatedCase() {
    const coop = await createTestCoop("OMB11");
    const member = await createTestMember(coop.id, { phone: "2348000050001" });
    const admin = await createTestMember(coop.id, {
      phone: "2348000050002",
      role: "admin",
      name: "Coop Admin",
    });
    const ombudsman = await prisma.ombudsman.create({
      data: { name: "Ada Ombuds", phone: "2348000059999", active: true },
    });
    const g = await createGrievance(coop.id, member.id);
    const escalated = await escalateCase(
      coop.id,
      member.id,
      { sourceType: "grievance", sourceId: g.id, category: "other", summary: "Needs review" },
      { id: member.id, phone: member.phone },
    );
    return { coop, member, admin, ombudsman, caseId: escalated.caseId! };
  }

  it("investigateCase moves the case to investigating and notifies the coop admins", async () => {
    const { caseId, ombudsman, admin } = await seedEscalatedCase();
    vi.mocked(sendText).mockClear();

    const res = await investigateCase(caseId, "Requesting the loan file", {
      id: ombudsman.id,
      phone: ombudsman.phone,
    });
    expect(res.ok).toBe(true);

    const c = await prisma.ombudsmanCase.findUnique({
      where: { id: caseId },
      include: { events: true },
    });
    expect(c!.status).toBe("investigating");
    const ev = c!.events.find((e) => e.action === "investigating");
    expect(ev).toBeTruthy();
    expect(ev!.actorRole).toBe("ombudsman");
    expect(ev!.actorId).toBe(ombudsman.id);
    expect(ev!.detail).toMatch(/loan file/i);

    const recipients = [
      ...vi.mocked(sendText).mock.calls.map((call) => call[0].to),
      ...vi.mocked(notifyMember).mock.calls.map((call) => call[0].phone),
    ];
    expect(recipients).toContain(admin.phone);
  });

  it("decideCase records a binding decision and notifies the member and coop", async () => {
    const { caseId, ombudsman, member, admin } = await seedEscalatedCase();
    vi.mocked(sendText).mockClear();

    const before = Date.now();
    const res = await decideCase(caseId, "Refund the disputed amount", {
      id: ombudsman.id,
      phone: ombudsman.phone,
    });
    expect(res.ok).toBe(true);

    const c = await prisma.ombudsmanCase.findUnique({
      where: { id: caseId },
      include: { events: true },
    });
    expect(c!.status).toBe("decided");
    expect(c!.decision).toBe("Refund the disputed amount");
    expect(c!.decisionById).toBe(ombudsman.id);
    expect(c!.decidedAt).toBeInstanceOf(Date);
    expect(c!.decidedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(c!.events.some((e) => e.action === "decided" && e.actorRole === "ombudsman")).toBe(
      true,
    );

    const recipients = [
      ...vi.mocked(sendText).mock.calls.map((call) => call[0].to),
      ...vi.mocked(notifyMember).mock.calls.map((call) => call[0].phone),
    ];
    expect(recipients).toContain(member.phone);
    expect(recipients).toContain(admin.phone);
  });

  it("refuses case actions from a non-ombudsman", async () => {
    const { caseId, member } = await seedEscalatedCase();

    const res = await investigateCase(caseId, "sneaky", { id: member.id, phone: member.phone });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ombudsman/i);

    const c = await prisma.ombudsmanCase.findUnique({ where: { id: caseId } });
    expect(c!.status).toBe("open");
    expect(
      await prisma.ombudsmanCaseEvent.count({ where: { caseId, action: "investigating" } }),
    ).toBe(0);
  });

  it("routes the ombudsman commands through chat", async () => {
    const { caseId, ombudsman } = await seedEscalatedCase();

    await handleMessage(ombudsman.phone, "cases");
    const listTexts = vi
      .mocked(sendText)
      .mock.calls.map((c) => c[0].text)
      .join("\n");
    expect(listTexts).toMatch(/case/i);

    await handleMessage(ombudsman.phone, `investigate ${caseId} need the file`);
    const investigating = await prisma.ombudsmanCase.findUnique({ where: { id: caseId } });
    expect(investigating!.status).toBe("investigating");

    await handleMessage(ombudsman.phone, `decide ${caseId} refund`);
    const decided = await prisma.ombudsmanCase.findUnique({ where: { id: caseId } });
    expect(decided!.status).toBe("decided");
    expect(decided!.decision).toBe("refund");
  });

  it("refuses to re-decide an already-decided or closed case", async () => {
    const { caseId, ombudsman } = await seedEscalatedCase();
    const actor = { id: ombudsman.id, phone: ombudsman.phone };

    const first = await decideCase(caseId, "Refund", actor);
    expect(first.ok).toBe(true);

    const second = await decideCase(caseId, "Reverse everything", actor);
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/already|closed/i);

    const c = await prisma.ombudsmanCase.findUnique({ where: { id: caseId } });
    expect(c!.decision).toBe("Refund");
    expect(await prisma.ombudsmanCaseEvent.count({ where: { caseId, action: "decided" } })).toBe(1);

    await prisma.ombudsmanCase.update({ where: { id: caseId }, data: { status: "closed" } });
    const closed = await decideCase(caseId, "reopen", actor);
    expect(closed.ok).toBe(false);
  });

  it("rolls back the status change if the timeline event cannot be written", async () => {
    const { caseId, ombudsman } = await seedEscalatedCase();
    // A null actorId violates the required OmbudsmanCaseEvent.actorId field, so
    // the event insert throws after the status update has been issued.
    await expect(
      investigateCase(caseId, "boom", { id: null as unknown as string, phone: ombudsman.phone }),
    ).rejects.toThrow();

    const c = await prisma.ombudsmanCase.findUnique({ where: { id: caseId } });
    expect(c!.status).toBe("open");
    expect(
      await prisma.ombudsmanCaseEvent.count({ where: { caseId, action: "investigating" } }),
    ).toBe(0);
  });

  it("rejects an unknown cases status filter with a hint", async () => {
    const { ombudsman } = await seedEscalatedCase();
    vi.mocked(sendText).mockClear();

    await handleMessage(ombudsman.phone, "cases bogus");
    const texts = vi
      .mocked(sendText)
      .mock.calls.map((c) => c[0].text)
      .join("\n");
    expect(texts).toMatch(/open/);
    expect(texts).toMatch(/investigating/);
    expect(texts).toMatch(/decided/);
    expect(texts).toMatch(/closed/);
    expect(texts).not.toMatch(/Ombudsman cases \(/);
  });
});
