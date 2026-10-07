import { prisma } from "../lib/prisma.js";
import { audit } from "./audit.js";

export const MEETING_TYPES = ["agm", "sgm"] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

export const MOTION_KINDS = ["general", "bylaw", "dividend", "election"] as const;
export type MotionKind = (typeof MOTION_KINDS)[number];

export const VOTE_CHOICES = ["yes", "no", "abstain"] as const;
export type VoteChoice = (typeof VOTE_CHOICES)[number];

/** A cooperative admin (or super admin) performing a governance action. */
export interface MeetingActor {
  id: string;
  role: string;
  phone?: string;
}

export interface MeetingResult {
  ok: boolean;
  message: string;
  meetingId?: string;
}

export interface MotionResult {
  ok: boolean;
  message: string;
  motionId?: string;
  passed?: boolean;
  status?: string;
  yes?: number;
  no?: number;
  abstain?: number;
  quorumMet?: boolean;
}

export interface QuorumResult {
  ok: boolean;
  message: string;
  met: boolean;
  present: number;
  eligible: number;
  required: number;
  quorumPercent: number;
}

function isAdminRole(role: string): boolean {
  return role === "admin" || role === "superadmin";
}

/** Only an active cooperative admin may run meeting-admin actions. */
function denyNonAdmin(actor: MeetingActor): string | null {
  if (!actor || !isAdminRole(actor.role)) {
    return "Only a cooperative *admin* can manage meetings.";
  }
  return null;
}

function actorFields(actor: MeetingActor) {
  return {
    actorPhone: actor.phone ?? "system",
    actorId: actor.id,
    actorRole: actor.role,
  };
}

function isValidMeetingType(type: string): type is MeetingType {
  return (MEETING_TYPES as readonly string[]).includes(type);
}

function isValidMotionKind(kind: string): kind is MotionKind {
  return (MOTION_KINDS as readonly string[]).includes(kind);
}

function isValidVoteChoice(choice: string): choice is VoteChoice {
  return (VOTE_CHOICES as readonly string[]).includes(choice);
}

/**
 * Resolve a meeting by full id or a trailing id fragment (commands accept the
 * short 6-char suffix shown in listings), scoped to the cooperative.
 */
async function resolveMeeting(coopId: string, ref: string) {
  const clean = (ref ?? "").trim();
  if (!clean) return null;
  return prisma.meeting.findFirst({
    where: {
      cooperativeId: coopId,
      ...(clean.length >= 20 ? { id: clean } : { id: { endsWith: clean } }),
    },
  });
}

/** Resolve a motion by full id or suffix, scoped to the cooperative. */
async function resolveMotion(coopId: string, ref: string) {
  const clean = (ref ?? "").trim();
  if (!clean) return null;
  return prisma.motion.findFirst({
    where: {
      cooperativeId: coopId,
      ...(clean.length >= 20 ? { id: clean } : { id: { endsWith: clean } }),
    },
    include: { meeting: true },
  });
}

/**
 * Schedule a general meeting (AGM or SGM). When no quorum is supplied the
 * cooperative's configured `agmQuorumPercent` is used (defaulting to 25).
 */
export async function startMeeting(
  coopId: string,
  type: string,
  title: string,
  quorumPercent: number | null | undefined,
  actor: MeetingActor,
): Promise<MeetingResult> {
  const denial = denyNonAdmin(actor);
  if (denial) return { ok: false, message: denial };

  const cleanType = (type ?? "").trim().toLowerCase();
  if (!isValidMeetingType(cleanType)) {
    return { ok: false, message: "Meeting type must be *agm* or *sgm*." };
  }

  const cleanTitle = (title ?? "").trim();
  if (!cleanTitle) return { ok: false, message: "A meeting needs a title." };

  let quorum = quorumPercent === null || quorumPercent === undefined ? NaN : Number(quorumPercent);
  if (!Number.isFinite(quorum)) {
    const cfg = await prisma.cooperativeConfig.findUnique({
      where: { cooperativeId: coopId },
      select: { agmQuorumPercent: true },
    });
    quorum = cfg?.agmQuorumPercent ?? 25;
  }
  if (quorum < 1 || quorum > 100) {
    return { ok: false, message: "Quorum must be between *1* and *100* percent." };
  }

  const meeting = await prisma.meeting.create({
    data: {
      cooperativeId: coopId,
      type: cleanType,
      title: cleanTitle,
      status: "scheduled",
      scheduledAt: new Date(),
      quorumPercent: Math.round(quorum),
      createdById: actor.id,
    },
  });

  await audit({
    cooperativeId: coopId,
    ...actorFields(actor),
    action: "meeting.schedule",
    targetType: "meeting",
    targetId: meeting.id,
    detail: `${cleanType.toUpperCase()} "${cleanTitle}" scheduled (quorum ${meeting.quorumPercent}%)`,
  });

  return {
    ok: true,
    meetingId: meeting.id,
    message: `✅ *${meeting.title}* (${cleanType.toUpperCase()}) scheduled — quorum *${meeting.quorumPercent}%*. Open it with *openmeeting ${meeting.id.slice(-6)}*.`,
  };
}

/** Move a scheduled meeting to open so attendance and motions are accepted. */
export async function openMeeting(
  coopId: string,
  meetingId: string,
  actor: MeetingActor,
): Promise<MeetingResult> {
  const denial = denyNonAdmin(actor);
  if (denial) return { ok: false, message: denial };

  const meeting = await resolveMeeting(coopId, meetingId);
  if (!meeting) return { ok: false, message: "Meeting not found. Check the id and try again." };
  if (meeting.status === "open") {
    return { ok: true, meetingId: meeting.id, message: "This meeting is already open." };
  }
  if (meeting.status === "closed") {
    return { ok: false, message: "This meeting is already closed." };
  }

  await prisma.meeting.update({
    where: { id: meeting.id },
    data: { status: "open", openedAt: new Date() },
  });

  await audit({
    cooperativeId: coopId,
    ...actorFields(actor),
    action: "meeting.open",
    targetType: "meeting",
    targetId: meeting.id,
    detail: `${meeting.type.toUpperCase()} "${meeting.title}" opened`,
  });

  return {
    ok: true,
    meetingId: meeting.id,
    message: `✅ *${meeting.title}* is now *open*. Members can *attend* and vote on *motions*.`,
  };
}

/** Close a meeting once the floor is done. */
export async function closeMeeting(
  coopId: string,
  meetingId: string,
  actor: MeetingActor,
): Promise<MeetingResult> {
  const denial = denyNonAdmin(actor);
  if (denial) return { ok: false, message: denial };

  const meeting = await resolveMeeting(coopId, meetingId);
  if (!meeting) return { ok: false, message: "Meeting not found. Check the id and try again." };
  if (meeting.status !== "open") {
    return { ok: false, message: "Only an *open* meeting can be closed." };
  }

  await prisma.meeting.update({
    where: { id: meeting.id },
    data: { status: "closed", closedAt: new Date() },
  });

  await audit({
    cooperativeId: coopId,
    ...actorFields(actor),
    action: "meeting.close",
    targetType: "meeting",
    targetId: meeting.id,
    detail: `${meeting.type.toUpperCase()} "${meeting.title}" closed`,
  });

  return {
    ok: true,
    meetingId: meeting.id,
    message: `🔒 *${meeting.title}* has been *closed*. Minutes: *meetingminutes ${meeting.id.slice(-6)}*.`,
  };
}

/** Record a member as present at an open meeting (self-scoped). */
export async function attendMeeting(
  coopId: string,
  meetingId: string,
  memberId: string,
): Promise<MeetingResult> {
  const meeting = await resolveMeeting(coopId, meetingId);
  if (!meeting) return { ok: false, message: "Meeting not found. Check the id and try again." };
  if (meeting.status !== "open") {
    return { ok: false, message: "You can only mark attendance while the meeting is *open*." };
  }

  const member = await prisma.member.findFirst({
    where: { id: memberId, cooperativeId: coopId },
    select: { id: true, name: true },
  });
  if (!member) return { ok: false, message: "You're not a member of this cooperative." };

  const existing = await prisma.meetingAttendance.findUnique({
    where: { meetingId_memberId: { meetingId: meeting.id, memberId: member.id } },
    select: { id: true },
  });
  if (existing) {
    return { ok: false, message: `${member.name} is already marked present at this meeting.` };
  }

  await prisma.meetingAttendance.create({
    data: { meetingId: meeting.id, memberId: member.id, present: true },
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: "member",
    actorId: member.id,
    actorRole: "member",
    action: "meeting.attend",
    targetType: "meeting",
    targetId: meeting.id,
    detail: `${member.name} attended ${meeting.title}`,
  });

  return {
    ok: true,
    meetingId: meeting.id,
    message: `✅ ${member.name}, you're marked *present* at *${meeting.title}*.`,
  };
}

/**
 * Register that `memberId` attends on behalf of the member with
 * `proxyMemberCode`. The represented member's attendance row carries the
 * proxy holder in `proxyForMemberId`, so quorum counts both of them.
 */
export async function assignProxy(
  coopId: string,
  meetingId: string,
  memberId: string,
  proxyMemberCode: string,
): Promise<MeetingResult> {
  const meeting = await resolveMeeting(coopId, meetingId);
  if (!meeting) return { ok: false, message: "Meeting not found. Check the id and try again." };
  if (meeting.status !== "open") {
    return { ok: false, message: "Proxies can only be assigned while the meeting is *open*." };
  }

  const holder = await prisma.member.findFirst({
    where: { id: memberId, cooperativeId: coopId },
    select: { id: true, name: true },
  });
  if (!holder) return { ok: false, message: "You're not a member of this cooperative." };

  const code = (proxyMemberCode ?? "").trim().toUpperCase();
  const absent = await prisma.member.findFirst({
    where: { cooperativeId: coopId, code },
    select: { id: true, name: true },
  });
  if (!absent) {
    return { ok: false, message: `No member with code *${code}* in your cooperative.` };
  }
  if (absent.id === holder.id) {
    return { ok: false, message: "You can't carry a proxy for yourself." };
  }

  const absentRow = await prisma.meetingAttendance.findUnique({
    where: { meetingId_memberId: { meetingId: meeting.id, memberId: absent.id } },
    select: { id: true },
  });
  const alreadyProxied = await prisma.meetingAttendance.findFirst({
    where: { meetingId: meeting.id, proxyForMemberId: absent.id },
    select: { id: true },
  });
  if (absentRow || alreadyProxied) {
    return { ok: false, message: `${absent.name} is already represented at this meeting.` };
  }

  // The proxy holder must be present in their own right to carry a proxy.
  const holderRow = await prisma.meetingAttendance.findUnique({
    where: { meetingId_memberId: { meetingId: meeting.id, memberId: holder.id } },
    select: { id: true },
  });
  if (!holderRow) {
    await prisma.meetingAttendance.create({
      data: { meetingId: meeting.id, memberId: holder.id, present: true },
    });
  }

  await prisma.meetingAttendance.create({
    data: {
      meetingId: meeting.id,
      memberId: absent.id,
      present: true,
      proxyForMemberId: holder.id,
    },
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: "member",
    actorId: holder.id,
    actorRole: "member",
    action: "meeting.proxy",
    targetType: "meeting",
    targetId: meeting.id,
    detail: `${holder.name} holds proxy for ${absent.name}`,
  });

  return {
    ok: true,
    meetingId: meeting.id,
    message: `✅ ${holder.name} now carries the proxy for *${absent.name}*.`,
  };
}

/** Put a motion to the floor of an open meeting. */
export async function addMotion(
  coopId: string,
  meetingId: string,
  title: string,
  description: string,
  kind: string,
  actor: MeetingActor,
): Promise<MotionResult> {
  const denial = denyNonAdmin(actor);
  if (denial) return { ok: false, message: denial };

  const meeting = await resolveMeeting(coopId, meetingId);
  if (!meeting) return { ok: false, message: "Meeting not found. Check the id and try again." };
  if (meeting.status !== "open") {
    return { ok: false, message: "Motions can only be added to an *open* meeting." };
  }

  const cleanTitle = (title ?? "").trim();
  if (!cleanTitle) return { ok: false, message: "A motion needs a title." };
  const cleanDescription = (description ?? "").trim();
  if (!cleanDescription) return { ok: false, message: "A motion needs a description." };

  const cleanKind = (kind ?? "general").trim().toLowerCase() || "general";
  if (!isValidMotionKind(cleanKind)) {
    return {
      ok: false,
      message: "Motion kind must be one of *general*, *bylaw*, *dividend* or *election*.",
    };
  }

  const motion = await prisma.motion.create({
    data: {
      meetingId: meeting.id,
      cooperativeId: coopId,
      title: cleanTitle,
      description: cleanDescription,
      kind: cleanKind,
      status: "open",
    },
  });

  await audit({
    cooperativeId: coopId,
    ...actorFields(actor),
    action: "motion.add",
    targetType: "motion",
    targetId: motion.id,
    detail: `${cleanKind} motion "${cleanTitle}" added to ${meeting.title}`,
  });

  return {
    ok: true,
    motionId: motion.id,
    message: `✅ Motion *${motion.title}* added. Members vote with *motionvote ${motion.id.slice(-6)} yes|no|abstain*.`,
  };
}

/** Record one member's vote on an open motion. Requires the member present. */
export async function castMotionVote(
  coopId: string,
  motionId: string,
  memberId: string,
  choice: string,
): Promise<MotionResult> {
  const cleanChoice = (choice ?? "").trim().toLowerCase();
  if (!isValidVoteChoice(cleanChoice)) {
    return { ok: false, message: "Your vote must be *yes*, *no* or *abstain*." };
  }

  const motion = await resolveMotion(coopId, motionId);
  if (!motion) return { ok: false, message: "Motion not found. Check the id and try again." };
  if (motion.status !== "open") {
    return { ok: false, message: "This motion is already decided." };
  }
  if (motion.meeting.status !== "open") {
    return { ok: false, message: "This meeting is not open for voting." };
  }

  const member = await prisma.member.findFirst({
    where: { id: memberId, cooperativeId: coopId },
    select: { id: true, name: true },
  });
  if (!member) return { ok: false, message: "You're not a member of this cooperative." };

  const attendance = await prisma.meetingAttendance.findUnique({
    where: { meetingId_memberId: { meetingId: motion.meetingId, memberId: member.id } },
    select: { present: true },
  });
  if (!attendance?.present) {
    return { ok: false, message: "Only members present at the meeting can vote." };
  }

  const existing = await prisma.motionVote.findUnique({
    where: { motionId_memberId: { motionId: motion.id, memberId: member.id } },
    select: { id: true },
  });
  if (existing) {
    return { ok: false, message: "You have already voted on this motion." };
  }

  await prisma.motionVote.create({
    data: { motionId: motion.id, memberId: member.id, choice: cleanChoice, viaProxy: false },
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: "member",
    actorId: member.id,
    actorRole: "member",
    action: "motion.vote",
    targetType: "motion",
    targetId: motion.id,
    detail: `${member.name} voted ${cleanChoice} on "${motion.title}"`,
  });

  return { ok: true, motionId: motion.id, message: `🗳️ Vote recorded: *${cleanChoice}*.` };
}

/**
 * Close a motion, tallying the votes. A motion passes only when the meeting
 * has quorum and there are more *yes* than *no* votes.
 */
export async function closeMotion(
  coopId: string,
  motionId: string,
  actor: MeetingActor,
): Promise<MotionResult> {
  const denial = denyNonAdmin(actor);
  if (denial) return { ok: false, message: denial };

  const motion = await resolveMotion(coopId, motionId);
  if (!motion) return { ok: false, message: "Motion not found. Check the id and try again." };
  if (motion.status !== "open") {
    return { ok: false, message: `This motion is already *${motion.status}*.` };
  }

  const votes = await prisma.motionVote.findMany({
    where: { motionId: motion.id },
    select: { choice: true },
  });
  const yes = votes.filter((v) => v.choice === "yes").length;
  const no = votes.filter((v) => v.choice === "no").length;
  const abstain = votes.filter((v) => v.choice === "abstain").length;

  const quorum = await quorumMet(coopId, motion.meetingId);
  const passed = quorum.met && yes > no;
  const status = passed ? "passed" : "rejected";

  await prisma.motion.update({
    where: { id: motion.id },
    data: { status, closedAt: new Date() },
  });

  await audit({
    cooperativeId: coopId,
    ...actorFields(actor),
    action: "motion.close",
    targetType: "motion",
    targetId: motion.id,
    detail: `"${motion.title}" ${status} (${yes} yes, ${no} no, ${abstain} abstain; quorum ${quorum.met ? "met" : "not met"})`,
  });

  const tally = `${yes} yes · ${no} no · ${abstain} abstain`;
  if (passed) {
    return {
      ok: true,
      motionId: motion.id,
      passed: true,
      status,
      yes,
      no,
      abstain,
      quorumMet: quorum.met,
      message: `✅ Motion *${motion.title}* has *passed* (${tally}).`,
    };
  }
  const reason = quorum.met ? "majority not reached" : "quorum not met";
  return {
    ok: true,
    motionId: motion.id,
    passed: false,
    status,
    yes,
    no,
    abstain,
    quorumMet: quorum.met,
    message: `❌ Motion *${motion.title}* was *rejected* (${tally}) — ${reason}.`,
  };
}

/** Whether the meeting has met its quorum of represented members. */
export async function quorumMet(coopId: string, meetingId: string): Promise<QuorumResult> {
  const meeting = await resolveMeeting(coopId, meetingId);
  if (!meeting) {
    return {
      ok: false,
      message: "Meeting not found. Check the id and try again.",
      met: false,
      present: 0,
      eligible: 0,
      required: 0,
      quorumPercent: 0,
    };
  }

  const [eligible, attendance] = await Promise.all([
    prisma.member.count({ where: { cooperativeId: coopId, status: { not: "deceased" } } }),
    prisma.meetingAttendance.findMany({
      where: { meetingId: meeting.id, present: true },
      select: { memberId: true, proxyForMemberId: true },
    }),
  ]);

  // A member counts once whether present in person or represented by proxy.
  const represented = new Set<string>();
  for (const row of attendance) {
    represented.add(row.memberId);
    if (row.proxyForMemberId) represented.add(row.proxyForMemberId);
  }
  const present = represented.size;
  const required = Math.ceil((eligible * meeting.quorumPercent) / 100);
  const met = eligible > 0 && present >= required;

  return {
    ok: true,
    met,
    present,
    eligible,
    required,
    quorumPercent: meeting.quorumPercent,
    message: `Quorum: *${present}/${eligible}* members present (${meeting.quorumPercent}% required). ${met ? "✅ Met." : "❌ Not met."}`,
  };
}

/** List a cooperative's meetings, most recent first. */
export async function listMeetings(
  coopId: string,
): Promise<{ ok: boolean; message: string; meetings: unknown[] }> {
  const meetings = await prisma.meeting.findMany({
    where: { cooperativeId: coopId },
    include: {
      _count: { select: { attendance: true, motions: true } },
    },
    orderBy: { scheduledAt: "desc" },
    take: 20,
  });

  if (meetings.length === 0) {
    return { ok: true, meetings, message: "No meetings have been called yet. 📭" };
  }

  const body = meetings
    .map((m) => {
      const when = m.scheduledAt.toLocaleDateString("en-GB");
      return `• *${m.title}* (${m.type.toUpperCase()}) — ${m.status} · ${when}\n   id *${m.id.slice(-6)}* · ${m._count.attendance} present · ${m._count.motions} motion(s) · quorum ${m.quorumPercent}%`;
    })
    .join("\n");

  return { ok: true, meetings, message: `*📅 Meetings*\n\n${body}` };
}

/** List the motions put to a meeting, with a live tally. */
export async function listMotions(
  coopId: string,
  meetingId: string,
): Promise<{ ok: boolean; message: string; motions: unknown[] }> {
  const meeting = await resolveMeeting(coopId, meetingId);
  if (!meeting) return { ok: false, motions: [], message: "Meeting not found." };

  const motions = await prisma.motion.findMany({
    where: { meetingId: meeting.id },
    include: { votes: { select: { choice: true } } },
    orderBy: { createdAt: "asc" },
  });

  if (motions.length === 0) {
    return { ok: true, motions, message: `No motions on *${meeting.title}* yet.` };
  }

  const body = motions
    .map((m) => {
      const yes = m.votes.filter((v) => v.choice === "yes").length;
      const no = m.votes.filter((v) => v.choice === "no").length;
      const abstain = m.votes.filter((v) => v.choice === "abstain").length;
      return `• *${m.title}* (${m.kind}) — ${m.status}\n   ${yes} yes · ${no} no · ${abstain} abstain\n   id *${m.id.slice(-6)}* · ${m.description}`;
    })
    .join("\n\n");

  return { ok: true, motions, message: `*🗳️ Motions — ${meeting.title}*\n\n${body}` };
}

/**
 * Build the minute-taking record for a meeting: attendance, quorum, and every
 * motion with its tally and outcome.
 */
export async function meetingMinutes(
  coopId: string,
  meetingId: string,
): Promise<{ ok: boolean; message: string }> {
  const meeting = await resolveMeeting(coopId, meetingId);
  if (!meeting) return { ok: false, message: "Meeting not found. Check the id and try again." };

  const [attendance, motions, quorum] = await Promise.all([
    prisma.meetingAttendance.findMany({
      where: { meetingId: meeting.id, present: true },
      include: {
        member: { select: { name: true, code: true } },
        proxyForMember: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.motion.findMany({
      where: { meetingId: meeting.id },
      include: { votes: { select: { choice: true } } },
      orderBy: { createdAt: "asc" },
    }),
    quorumMet(coopId, meeting.id),
  ]);

  const attendanceLines = attendance.map((row) =>
    row.proxyForMember
      ? `• ${row.member.name} (${row.member.code}) — by proxy of ${row.proxyForMember.name}`
      : `• ${row.member.name} (${row.member.code})`,
  );

  const motionLines = motions.map((m) => {
    const yes = m.votes.filter((v) => v.choice === "yes").length;
    const no = m.votes.filter((v) => v.choice === "no").length;
    const abstain = m.votes.filter((v) => v.choice === "abstain").length;
    return `*${m.title}* (${m.kind}) — ${m.status.toUpperCase()}\n   ${yes} yes · ${no} no · ${abstain} abstain`;
  });

  const lines = [
    `*📜 Minutes — ${meeting.title}*`,
    `Type: ${meeting.type.toUpperCase()} · Status: ${meeting.status}`,
    `Called: ${meeting.createdAt.toLocaleDateString("en-GB")}`,
    "",
    `*Quorum:* ${quorum.present}/${quorum.eligible} present — ${quorum.met ? "met ✅" : "NOT met ❌"} (required ${quorum.required})`,
    "",
    `*Attendance (${attendance.length}):*`,
    attendanceLines.length > 0 ? attendanceLines.join("\n") : "• none recorded",
    "",
    `*Motions (${motions.length}):*`,
    motionLines.length > 0 ? motionLines.join("\n\n") : "• none tabled",
  ];

  return { ok: true, message: lines.join("\n") };
}
