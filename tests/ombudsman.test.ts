import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { escalateCase, listCases, getCase, isOmbudsman } from "../src/services/ombudsman.js";
import { sendText } from "../src/lib/messaging.js";
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
