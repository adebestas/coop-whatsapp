import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupDatabase, createTestCoop, createTestMember, prisma } from "./setup.js";
import {
  addMotion,
  assignProxy,
  attendMeeting,
  castMotionVote,
  closeMeeting,
  closeMotion,
  listMotions,
  listMeetings,
  meetingMinutes,
  openMeeting,
  quorumMet,
  startMeeting,
} from "../src/services/meetings.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";

function textsSent(): string {
  return vi
    .mocked(sendText)
    .mock.calls.map((c) => c[0].text)
    .join("\n");
}

const SUPER = { phone: "2348090000001", role: "superadmin" as const };

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanupDatabase();
});

describe("meeting service", () => {
  it("runs an AGM end to end: open, attend, vote, pass with quorum, minutes", async () => {
    const coop = await createTestCoop("MTG01");
    const admin = await createTestMember(coop.id, SUPER);
    const a = await createTestMember(coop.id, { phone: "2348010000001", name: "Ada Obi" });
    const b = await createTestMember(coop.id, { phone: "2348010000002", name: "Bola Ade" });
    const c = await createTestMember(coop.id, { phone: "2348010000003", name: "Chidi Eze" });
    const actor = { phone: admin.phone, id: admin.id, role: "superadmin" };

    const started = await startMeeting(coop.id, "agm", "2026 Annual General Meeting", 50, actor);
    expect(started.ok).toBe(true);
    expect(started.meetingId).toBeTruthy();
    const meetingId = started.meetingId!;

    const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
    expect(meeting!.type).toBe("agm");
    expect(meeting!.status).toBe("scheduled");
    expect(meeting!.quorumPercent).toBe(50);

    expect((await openMeeting(coop.id, meetingId, actor)).ok).toBe(true);
    expect((await prisma.meeting.findUnique({ where: { id: meetingId } }))!.status).toBe("open");

    // Two of the four members attend — exactly the 50% quorum.
    expect((await attendMeeting(coop.id, meetingId, a.id)).ok).toBe(true);
    expect((await attendMeeting(coop.id, meetingId, b.id)).ok).toBe(true);
    // Duplicate attendance is refused.
    expect((await attendMeeting(coop.id, meetingId, a.id)).ok).toBe(false);

    const quorum = await quorumMet(coop.id, meetingId);
    expect(quorum.met).toBe(true);
    expect(quorum.present).toBe(2);

    const motion = await addMotion(
      coop.id,
      meetingId,
      "Approve 5% dividend",
      "Pay a 5% dividend to all members.",
      "dividend",
      actor,
    );
    expect(motion.ok).toBe(true);
    const motionId = motion.motionId!;
    expect((await prisma.motion.findUnique({ where: { id: motionId } }))!.kind).toBe("dividend");

    expect((await castMotionVote(coop.id, motionId, a.id, "yes")).ok).toBe(true);
    expect((await castMotionVote(coop.id, motionId, b.id, "yes")).ok).toBe(true);
    // A member who did not attend cannot vote.
    expect((await castMotionVote(coop.id, motionId, c.id, "no")).ok).toBe(false);

    const closed = await closeMotion(coop.id, motionId, actor);
    expect(closed.ok).toBe(true);
    expect(closed.passed).toBe(true);
    expect((await prisma.motion.findUnique({ where: { id: motionId } }))!.status).toBe("passed");

    const minutes = await meetingMinutes(coop.id, meetingId);
    expect(minutes.ok).toBe(true);
    expect(minutes.message).toContain("2026 Annual General Meeting");
    expect(minutes.message).toContain("Approve 5% dividend");
    expect(minutes.message).toContain("Ada Obi");

    expect((await closeMeeting(coop.id, meetingId, actor)).ok).toBe(true);
    expect((await prisma.meeting.findUnique({ where: { id: meetingId } }))!.status).toBe("closed");
  });

  it("blocks a non-admin from starting or closing a meeting", async () => {
    const coop = await createTestCoop("MTG02");
    const admin = await createTestMember(coop.id, SUPER);
    const member = await createTestMember(coop.id, { phone: "2348010000010" });
    const nonAdmin = { id: member.id, role: "member", phone: member.phone };

    const denied = await startMeeting(coop.id, "agm", "Hijack AGM", 50, nonAdmin);
    expect(denied.ok).toBe(false);
    expect(denied.message.toLowerCase()).toContain("admin");
    expect(await prisma.meeting.count()).toBe(0);

    // A real meeting still cannot be closed by a plain member.
    const actor = { phone: admin.phone, id: admin.id, role: "superadmin" };
    const started = await startMeeting(coop.id, "sgm", "Special Meeting", 25, actor);
    await openMeeting(coop.id, started.meetingId!, actor);
    expect((await closeMeeting(coop.id, started.meetingId!, nonAdmin)).ok).toBe(false);

    // And the command layer refuses a plain member too.
    await handleMessage(member.phone, "startmeeting agm Hijack 50");
    expect(await prisma.meeting.count()).toBe(1);
  });

  it("rejects an invalid meeting type and motion kind", async () => {
    const coop = await createTestCoop("MTG05");
    const admin = await createTestMember(coop.id, SUPER);
    const actor = { phone: admin.phone, id: admin.id, role: "superadmin" };

    expect((await startMeeting(coop.id, "egm", "Bad type", 50, actor)).ok).toBe(false);

    const started = await startMeeting(coop.id, "agm", "Good AGM", 50, actor);
    await openMeeting(coop.id, started.meetingId!, actor);
    expect(
      (await addMotion(coop.id, started.meetingId!, "Bad", "Bad kind", "coup", actor)).ok,
    ).toBe(false);
  });

  it("prevents a member from voting twice on the same motion", async () => {
    const coop = await createTestCoop("MTG03");
    const admin = await createTestMember(coop.id, SUPER);
    const a = await createTestMember(coop.id, { phone: "2348010000020" });
    const actor = { phone: admin.phone, id: admin.id, role: "superadmin" };

    const started = await startMeeting(coop.id, "agm", "Vote Test", 25, actor);
    const meetingId = started.meetingId!;
    await openMeeting(coop.id, meetingId, actor);
    await attendMeeting(coop.id, meetingId, a.id);
    const motion = await addMotion(coop.id, meetingId, "Motion", "Description", "general", actor);
    const motionId = motion.motionId!;

    expect((await castMotionVote(coop.id, motionId, a.id, "yes")).ok).toBe(true);
    const again = await castMotionVote(coop.id, motionId, a.id, "no");
    expect(again.ok).toBe(false);
    expect(again.message.toLowerCase()).toContain("already voted");
    expect(await prisma.motionVote.count()).toBe(1);
  });

  it("counts proxy attendance toward quorum", async () => {
    const coop = await createTestCoop("MTG04");
    const admin = await createTestMember(coop.id, SUPER);
    const a = await createTestMember(coop.id, { phone: "2348010000030", name: "Ada" });
    const b = await createTestMember(coop.id, { phone: "2348010000031", name: "Bola" });
    await createTestMember(coop.id, { phone: "2348010000032", name: "Chidi" });
    const actor = { phone: admin.phone, id: admin.id, role: "superadmin" };

    const started = await startMeeting(coop.id, "agm", "Proxy AGM", 50, actor);
    const meetingId = started.meetingId!;
    await openMeeting(coop.id, meetingId, actor);
    await attendMeeting(coop.id, meetingId, a.id);

    // One member present, 1/4 = 25% — below the 50% quorum.
    expect((await quorumMet(coop.id, meetingId)).met).toBe(false);

    // Ada carries Bola's proxy: both now count, 2/4 = 50%.
    const proxy = await assignProxy(coop.id, meetingId, a.id, b.code);
    expect(proxy.ok).toBe(true);
    const q = await quorumMet(coop.id, meetingId);
    expect(q.met).toBe(true);
    expect(q.present).toBe(2);

    const row = await prisma.meetingAttendance.findFirst({
      where: { meetingId, memberId: b.id },
    });
    expect(row!.proxyForMemberId).toBe(a.id);
  });

  it("counts only active members toward the quorum denominator", async () => {
    const coop = await createTestCoop("MTG09");
    const admin = await createTestMember(coop.id, SUPER);
    const a = await createTestMember(coop.id, { phone: "2348010000060", name: "Ada" });
    await createTestMember(coop.id, { phone: "2348010000061", name: "Bola" });
    await createTestMember(coop.id, { phone: "2348010000062", name: "Chidi" });
    // Pending/suspended members must not inflate the denominator.
    for (const [i, status] of (["pending", "suspended", "pending"] as const).entries()) {
      const m = await createTestMember(coop.id, { phone: `234801000006${3 + i}` });
      await prisma.member.update({ where: { id: m.id }, data: { status } });
    }
    const actor = { phone: admin.phone, id: admin.id, role: "superadmin" };

    const started = await startMeeting(coop.id, "agm", "Active-only Quorum", 25, actor);
    const meetingId = started.meetingId!;
    await openMeeting(coop.id, meetingId, actor);
    await attendMeeting(coop.id, meetingId, a.id);

    const q = await quorumMet(coop.id, meetingId);
    expect(q.eligible).toBe(4);
    expect(q.required).toBe(1);
    expect(q.met).toBe(true);
  });

  it("lists meetings and motions for members", async () => {
    const coop = await createTestCoop("MTG06");
    const admin = await createTestMember(coop.id, SUPER);
    const actor = { phone: admin.phone, id: admin.id, role: "superadmin" };
    const started = await startMeeting(coop.id, "agm", "Listed AGM", 25, actor);
    await openMeeting(coop.id, started.meetingId!, actor);
    await addMotion(coop.id, started.meetingId!, "Listed Motion", "Desc", "bylaw", actor);

    const list = await listMeetings(coop.id);
    expect(list.ok).toBe(true);
    expect(list.meetings.length).toBe(1);
    expect(list.message).toContain("Listed AGM");

    const motions = await listMotions(coop.id, started.meetingId!);
    expect(motions.ok).toBe(true);
    expect(motions.message).toContain("Listed Motion");

    const actions = (
      await prisma.auditLog.findMany({ where: { cooperativeId: coop.id }, select: { action: true } })
    ).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["meeting.schedule", "meeting.open", "motion.add"]),
    );
  });
});

describe("meeting chat commands", () => {
  it("routes admin and member meeting commands", async () => {
    const coop = await createTestCoop("MTG07");
    const admin = await createTestMember(coop.id, SUPER);
    const a = await createTestMember(coop.id, { phone: "2348010000040", name: "Ada" });
    await createTestMember(coop.id, { phone: "2348010000041", name: "Bola" });

    await handleMessage(admin.phone, "startmeeting agm Annual General Meeting 50");
    const meeting = await prisma.meeting.findFirst({ where: { cooperativeId: coop.id } });
    expect(meeting).not.toBeNull();
    expect(meeting!.quorumPercent).toBe(50);
    const shortId = meeting!.id.slice(-6);

    await handleMessage(admin.phone, `openmeeting ${shortId}`);
    expect((await prisma.meeting.findUnique({ where: { id: meeting!.id } }))!.status).toBe("open");

    await handleMessage(a.phone, `attend ${shortId}`);
    expect(await prisma.meetingAttendance.count()).toBe(1);

    await handleMessage(
      admin.phone,
      `addmotion ${shortId} New byelaw | Adopt the new byelaw for the cooperative bylaw`,
    );
    const motion = await prisma.motion.findFirst({ where: { meetingId: meeting!.id } });
    expect(motion).not.toBeNull();
    expect(motion!.kind).toBe("bylaw");
    expect(motion!.description.toLowerCase()).toBe("adopt the new byelaw for the cooperative");
    const mShort = motion!.id.slice(-6);

    await handleMessage(a.phone, `motions ${shortId}`);
    expect(textsSent().toLowerCase()).toContain("new byelaw");

    await handleMessage(a.phone, `motionvote ${mShort} yes`);
    expect(await prisma.motionVote.count()).toBe(1);
    // Duplicate vote through chat is refused.
    await handleMessage(a.phone, `motionvote ${mShort} yes`);
    expect(await prisma.motionVote.count()).toBe(1);

    await handleMessage(admin.phone, `closemotion ${mShort}`);
    expect((await prisma.motion.findUnique({ where: { id: motion!.id } }))!.closedAt).not.toBeNull();

    await handleMessage(admin.phone, `meetingminutes ${shortId}`);
    expect(textsSent().toLowerCase()).toContain("annual general meeting");

    await handleMessage(admin.phone, `closemeeting ${shortId}`);
    expect((await prisma.meeting.findUnique({ where: { id: meeting!.id } }))!.status).toBe("closed");

    await handleMessage(a.phone, "meetings");
    expect(textsSent().toLowerCase()).toContain("annual general meeting");
  });

  it("lets a member carry a proxy through chat", async () => {
    const coop = await createTestCoop("MTG08");
    const admin = await createTestMember(coop.id, SUPER);
    const a = await createTestMember(coop.id, { phone: "2348010000050", name: "Ada" });
    const b = await createTestMember(coop.id, { phone: "2348010000051", name: "Bola" });
    await createTestMember(coop.id, { phone: "2348010000052", name: "Chidi" });

    await handleMessage(admin.phone, "startmeeting agm Proxy AGM 50");
    const meeting = await prisma.meeting.findFirst({ where: { cooperativeId: coop.id } });
    const shortId = meeting!.id.slice(-6);
    await handleMessage(admin.phone, `openmeeting ${shortId}`);
    await handleMessage(a.phone, `attend ${shortId}`);
    await handleMessage(a.phone, `proxy ${shortId} ${b.code}`);
    expect(await prisma.meetingAttendance.count()).toBe(2);
    expect((await quorumMet(coop.id, meeting!.id)).met).toBe(true);
  });
});
