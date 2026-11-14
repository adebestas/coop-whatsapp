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

async function seedMeeting(coopId: string, createdById: string, title = "AGM 2026") {
  return prisma.meeting.create({
    data: {
      cooperativeId: coopId,
      type: "agm",
      title,
      scheduledAt: new Date("2026-06-01T10:00:00Z"),
      status: "scheduled",
      quorumPercent: 25,
      createdById,
    },
  });
}

describe("admin meetings", () => {
  it("lists meetings with attendance and motion counts, scoped to the cooperative", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("MTG1");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348093000001",
      pin: "1234",
    });
    const member = await createTestMember(coop.id, { phone: "2348093000002" });
    const meeting = await seedMeeting(coop.id, admin.id);
    await prisma.meetingAttendance.create({
      data: { meetingId: meeting.id, memberId: member.id, present: true },
    });
    await prisma.motion.create({
      data: {
        meetingId: meeting.id,
        cooperativeId: coop.id,
        title: "Raise dues",
        description: "Monthly dues from ₦2,000 to ₦3,000",
        kind: "general",
      },
    });

    const otherCoop = await createTestCoop("MTG2");
    const otherAdmin = await createTestMember(otherCoop.id, { phone: "2348093000003" });
    await seedMeeting(otherCoop.id, otherAdmin.id, "Other AGM");

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/meetings",
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.meetings).toHaveLength(1);
    expect(body.meetings[0]).toMatchObject({
      id: meeting.id,
      title: "AGM 2026",
      type: "agm",
      status: "scheduled",
      quorumPercent: 25,
      attendanceCount: 1,
      motionCount: 1,
    });
  });

  it("returns meeting detail with attendance, motion tallies and quorum", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("MTG3");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348093000011",
      pin: "1234",
    });
    const member = await createTestMember(coop.id, {
      phone: "2348093000012",
      name: "Ngozi Okeke",
    });
    const meeting = await seedMeeting(coop.id, admin.id);
    await prisma.meetingAttendance.create({
      data: { meetingId: meeting.id, memberId: member.id, present: true },
    });
    const motion = await prisma.motion.create({
      data: {
        meetingId: meeting.id,
        cooperativeId: coop.id,
        title: "Raise dues",
        description: "Monthly dues increase",
        kind: "general",
        status: "open",
      },
    });
    await prisma.motionVote.create({
      data: { motionId: motion.id, memberId: member.id, choice: "yes" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/admin/meetings/${meeting.id}`,
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.meeting).toMatchObject({ id: meeting.id, title: "AGM 2026" });
    expect(body.attendance).toHaveLength(1);
    expect(body.attendance[0]).toMatchObject({ memberName: "Ngozi Okeke", present: true });
    expect(body.motions).toHaveLength(1);
    expect(body.motions[0]).toMatchObject({ id: motion.id, yes: 1, no: 0, abstain: 0 });
    expect(body.quorum).toMatchObject({ eligible: 2, present: 1, required: 1, met: true });
  });

  it("returns 404 for a meeting in another cooperative", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("MTG4");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348093000021",
      pin: "1234",
    });
    const otherCoop = await createTestCoop("MTG5");
    const otherAdmin = await createTestMember(otherCoop.id, { phone: "2348093000022" });
    const otherMeeting = await seedMeeting(otherCoop.id, otherAdmin.id);

    const res = await app.inject({
      method: "GET",
      url: `/api/admin/meetings/${otherMeeting.id}`,
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("admin committees", () => {
  it("lists committees with members and pending decisions, scoped to the cooperative", async () => {
    const app = await createTestApp();
    const coop = await createTestCoop("CMT1");
    const admin = await createTestMember(coop.id, {
      role: "admin",
      phone: "2348093000031",
      pin: "1234",
    });
    const member = await createTestMember(coop.id, {
      phone: "2348093000032",
      name: "Tunde Bakare",
    });
    const committee = await prisma.committee.create({
      data: { cooperativeId: coop.id, type: "credit", name: "Credit Committee", size: 3 },
    });
    await prisma.committeeMember.create({
      data: { committeeId: committee.id, memberId: member.id, role: "chair" },
    });
    await prisma.committeeDecision.create({
      data: {
        cooperativeId: coop.id,
        committeeId: committee.id,
        subjectType: "loan",
        subjectId: "loan_1",
        status: "pending",
      },
    });

    const otherCoop = await createTestCoop("CMT2");
    await prisma.committee.create({
      data: { cooperativeId: otherCoop.id, type: "credit", name: "Other Credit", size: 3 },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/committees",
      headers: { cookie: await loginAs(app, admin.phone) },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.committees).toHaveLength(1);
    expect(body.committees[0]).toMatchObject({
      id: committee.id,
      type: "credit",
      name: "Credit Committee",
      size: 3,
      pendingDecisions: 1,
    });
    expect(body.committees[0].members).toHaveLength(1);
    expect(body.committees[0].members[0]).toMatchObject({
      memberId: member.id,
      name: "Tunde Bakare",
      role: "chair",
      active: true,
    });
  });
});
