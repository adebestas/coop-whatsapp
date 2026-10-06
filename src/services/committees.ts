import { prisma } from "../lib/prisma.js";
import { audit } from "./audit.js";

export const COMMITTEE_TYPES = ["credit", "supervisory", "board"] as const;
export type CommitteeType = (typeof COMMITTEE_TYPES)[number];

/** How many votes make a bare majority of a committee of `size` seats. */
export function committeeMajority(size: number): number {
  return Math.floor(size / 2) + 1;
}

function isValidType(type: string): type is CommitteeType {
  return (COMMITTEE_TYPES as readonly string[]).includes(type);
}

/** The admin performing the action. Only super admins may manage committees. */
export interface CommitteeActor {
  id: string;
  role: string;
  phone?: string;
}

/**
 * Authorization gate. Committee setup is a governance action reserved for the
 * super admin — enforced here in the service as well as at the command layer so
 * every caller (commands, jobs, future APIs) is covered.
 */
function denyNonSuper(actor: CommitteeActor): string | null {
  if (!actor || actor.role !== "superadmin") {
    return "Only the *super admin* can manage committees.";
  }
  return null;
}

function actorFields(actor: CommitteeActor) {
  return {
    actorPhone: actor.phone ?? "system",
    actorId: actor.id,
    actorRole: actor.role,
  };
}

export interface CommitteeResult {
  ok: boolean;
  message: string;
  committeeId?: string;
}

export interface CommitteeMemberSummary {
  memberId: string;
  name: string;
  code: string;
  role: string;
}

export interface CommitteeSummary {
  id: string;
  type: string;
  name: string;
  size: number;
  members: CommitteeMemberSummary[];
}

/**
 * Create one of the three statutory committees for a cooperative. Enforces the
 * one-committee-per-type rule (`@@unique([cooperativeId, type])`) and audits.
 */
export async function createCommittee(
  coopId: string,
  type: string,
  name: string,
  size: number,
  actor: CommitteeActor,
): Promise<CommitteeResult> {
  const denial = denyNonSuper(actor);
  if (denial) return { ok: false, message: denial };

  const cleanType = (type ?? "").trim().toLowerCase();
  if (!isValidType(cleanType)) {
    return {
      ok: false,
      message: "Committee type must be one of *credit*, *supervisory* or *board*.",
    };
  }

  const cleanName = (name ?? "").trim();
  if (!cleanName) {
    return { ok: false, message: "A committee needs a name." };
  }

  const cleanSize = Number(size);
  if (!Number.isFinite(cleanSize) || cleanSize < 3) {
    return {
      ok: false,
      message: "Committee size must be at least *3* so a decision always needs more than one vote.",
    };
  }

  const existing = await prisma.committee.findUnique({
    where: { cooperativeId_type: { cooperativeId: coopId, type: cleanType } },
    select: { id: true },
  });
  if (existing) {
    return { ok: false, message: `A *${cleanType}* committee already exists (${existing.id.slice(-6)}).` };
  }

  const committee = await prisma.committee.create({
    data: { cooperativeId: coopId, type: cleanType, name: cleanName, size: Math.floor(cleanSize) },
  });

  await audit({
    cooperativeId: coopId,
    ...actorFields(actor),
    action: "committee.create",
    targetType: "committee",
    targetId: committee.id,
    detail: `${cleanType} committee "${cleanName}" created (size ${committee.size})`,
  });

  return {
    ok: true,
    committeeId: committee.id,
    message: `✅ *${cleanName}* committee created (size ${committee.size}). Appoint members with *appoint ${cleanType} <member code>*.`,
  };
}

/**
 * Appoint a member to a committee seat. Rejects members already actively on the
 * committee; a previously removed seat is reactivated rather than duplicated.
 */
export async function appointMember(
  coopId: string,
  type: string,
  memberCode: string,
  role: string,
  actor: CommitteeActor,
): Promise<CommitteeResult> {
  const denial = denyNonSuper(actor);
  if (denial) return { ok: false, message: denial };

  const cleanType = (type ?? "").trim().toLowerCase();
  if (!isValidType(cleanType)) {
    return {
      ok: false,
      message: "Committee type must be one of *credit*, *supervisory* or *board*.",
    };
  }

  const committee = await prisma.committee.findUnique({
    where: { cooperativeId_type: { cooperativeId: coopId, type: cleanType } },
    select: { id: true, name: true, size: true },
  });
  if (!committee) {
    return {
      ok: false,
      message: `No *${cleanType}* committee yet. Create one with *addcommittee ${cleanType} <name> [size]*.`,
    };
  }

  const cleanRole = role?.trim().toLowerCase() === "chair" ? "chair" : "member";

  const code = (memberCode ?? "").trim().toUpperCase();
  const member = await prisma.member.findFirst({
    where: { cooperativeId: coopId, code },
    select: { id: true, name: true },
  });
  if (!member) {
    return { ok: false, message: `No member with code *${code}* in your cooperative.` };
  }

  const existing = await prisma.committeeMember.findUnique({
    where: { committeeId_memberId: { committeeId: committee.id, memberId: member.id } },
    select: { id: true, active: true },
  });
  if (existing?.active) {
    return { ok: false, message: `${member.name} is already on the *${committee.name}*.` };
  }

  if (existing) {
    await prisma.committeeMember.update({
      where: { id: existing.id },
      data: {
        active: true,
        role: cleanRole,
        appointedById: actor.id,
        appointedAt: new Date(),
      },
    });
  } else {
    await prisma.committeeMember.create({
      data: {
        committeeId: committee.id,
        memberId: member.id,
        role: cleanRole,
        appointedById: actor.id,
      },
    });
  }

  await audit({
    cooperativeId: coopId,
    ...actorFields(actor),
    action: "committee.appoint",
    targetType: "member",
    targetId: member.id,
    detail: `${member.name} appointed ${cleanRole} of ${committee.name}`,
  });

  return {
    ok: true,
    message: `✅ ${member.name} is now *${cleanRole}* of the *${committee.name}*.`,
  };
}

/** Soft-remove a member from a committee (seat is freed, history retained). */
export async function removeMember(
  coopId: string,
  type: string,
  memberCode: string,
  actor: CommitteeActor,
): Promise<CommitteeResult> {
  const denial = denyNonSuper(actor);
  if (denial) return { ok: false, message: denial };

  const cleanType = (type ?? "").trim().toLowerCase();
  if (!isValidType(cleanType)) {
    return {
      ok: false,
      message: "Committee type must be one of *credit*, *supervisory* or *board*.",
    };
  }

  const committee = await prisma.committee.findUnique({
    where: { cooperativeId_type: { cooperativeId: coopId, type: cleanType } },
    select: { id: true, name: true },
  });
  if (!committee) {
    return { ok: false, message: `No *${cleanType}* committee in your cooperative.` };
  }

  const code = (memberCode ?? "").trim().toUpperCase();
  const member = await prisma.member.findFirst({
    where: { cooperativeId: coopId, code },
    select: { id: true, name: true },
  });
  if (!member) {
    return { ok: false, message: `No member with code *${code}* in your cooperative.` };
  }

  const existing = await prisma.committeeMember.findUnique({
    where: { committeeId_memberId: { committeeId: committee.id, memberId: member.id } },
    select: { id: true, active: true },
  });
  if (!existing?.active) {
    return { ok: false, message: `${member.name} is not on the *${committee.name}*.` };
  }

  await prisma.committeeMember.update({ where: { id: existing.id }, data: { active: false } });

  await audit({
    cooperativeId: coopId,
    ...actorFields(actor),
    action: "committee.remove",
    targetType: "member",
    targetId: member.id,
    detail: `${member.name} removed from ${committee.name}`,
  });

  return { ok: true, message: `✅ ${member.name} has been removed from the *${committee.name}*.` };
}

/** List every committee and its active members for an admin. */
export async function listCommittees(
  coopId: string,
): Promise<{ ok: boolean; message: string; committees: CommitteeSummary[] }> {
  const rows = await prisma.committee.findMany({
    where: { cooperativeId: coopId },
    include: {
      members: {
        where: { active: true },
        orderBy: { appointedAt: "asc" },
        include: { member: { select: { id: true, name: true, code: true } } },
      },
    },
    orderBy: { type: "asc" },
  });

  const committees: CommitteeSummary[] = rows.map((c) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    size: c.size,
    members: c.members.map((cm) => ({
      memberId: cm.member.id,
      name: cm.member.name,
      code: cm.member.code,
      role: cm.role,
    })),
  }));

  if (committees.length === 0) {
    return {
      ok: true,
      committees,
      message:
        "No committees have been created yet. Use *addcommittee <credit|supervisory|board> <name> [size]*.",
    };
  }

  const body = committees
    .map((c) => {
      const seats = `${c.members.length}/${c.size}`;
      const lines = c.members.map((m) => `   • ${m.role}: ${m.name} (${m.code})`);
      return `*${c.name}* (${c.type}) — ${seats} seats\n${lines.join("\n") || "   • no members yet"}`;
    })
    .join("\n\n");

  return { ok: true, committees, message: `*Committees*\n\n${body}` };
}

/** True when `memberId` currently holds an active seat on `type`. */
export async function isCommitteeMember(
  coopId: string,
  type: string,
  memberId: string,
): Promise<boolean> {
  const cleanType = (type ?? "").trim().toLowerCase();
  if (!isValidType(cleanType)) return false;
  const seat = await prisma.committeeMember.findFirst({
    where: {
      memberId,
      active: true,
      committee: { cooperativeId: coopId, type: cleanType },
    },
    select: { id: true },
  });
  return seat !== null;
}

/**
 * True when the cooperative has a `type` committee staffed to at least a bare
 * majority of its configured seats. A committee that is created but not yet
 * staffed to a majority is NOT "active": the cooperative keeps its legacy
 * approval chain until the committee can actually decide, so a single person
 * can never disburse a loan and a loan can never strand waiting for votes that
 * no one is seated to cast.
 *
 * `committeeMajority(size)` rather than `activeSeats` is the bar, so a size-3
 * committee needs ≥2 seated, a size-5 needs ≥3, etc.
 */
export async function hasActiveCommittee(coopId: string, type: string): Promise<boolean> {
  const cleanType = (type ?? "").trim().toLowerCase();
  if (!isValidType(cleanType)) return false;
  const committee = await prisma.committee.findUnique({
    where: { cooperativeId_type: { cooperativeId: coopId, type: cleanType } },
    select: { id: true, size: true },
  });
  if (!committee) return false;
  const seated = await prisma.committeeMember.count({
    where: { committeeId: committee.id, active: true },
  });
  return seated >= committeeMajority(committee.size);
}

export interface CommitteeVoteResult {
  ok: boolean;
  message: string;
  /** Set the moment the vote tally crosses a decision threshold. */
  decided?: "approved" | "rejected";
}

/**
 * Record one committee member's vote on a subject (e.g. a loan) and evaluate
 * the tally. Creates the pending `CommitteeDecision` on first vote, rejects
 * duplicate votes, and flips the decision to approved/rejected once a bare
 * majority is reached (or once enough rejections make approval impossible).
 */
export async function recordCommitteeVote(
  coopId: string,
  type: string,
  subjectType: string,
  subjectId: string,
  memberId: string,
  vote: string,
): Promise<CommitteeVoteResult> {
  const cleanType = (type ?? "").trim().toLowerCase();
  if (!isValidType(cleanType)) {
    return { ok: false, message: "Unknown committee type." };
  }
  const cleanVote = (vote ?? "").trim().toLowerCase();
  if (cleanVote !== "approve" && cleanVote !== "reject") {
    return { ok: false, message: "Vote must be *approve* or *reject*." };
  }

  const committee = await prisma.committee.findUnique({
    where: { cooperativeId_type: { cooperativeId: coopId, type: cleanType } },
    select: { id: true, name: true, size: true },
  });
  if (!committee) {
    return { ok: false, message: `No *${cleanType}* committee in your cooperative.` };
  }

  const seat = await prisma.committeeMember.findUnique({
    where: { committeeId_memberId: { committeeId: committee.id, memberId } },
    select: { active: true },
  });
  if (!seat?.active) {
    return { ok: false, message: `Only active members of the *${committee.name}* may vote.` };
  }

  let decision = await prisma.committeeDecision.findUnique({
    where: {
      committeeId_subjectType_subjectId: { committeeId: committee.id, subjectType, subjectId },
    },
    select: { id: true, status: true },
  });
  if (!decision) {
    decision = await prisma.committeeDecision.create({
      data: {
        cooperativeId: coopId,
        committeeId: committee.id,
        subjectType,
        subjectId,
        status: "pending",
      },
      select: { id: true, status: true },
    });
  }
  if (decision.status !== "pending") {
    return { ok: false, message: `This decision is already *${decision.status}*.` };
  }

  const existing = await prisma.committeeVote.findUnique({
    where: { decisionId_memberId: { decisionId: decision.id, memberId } },
    select: { id: true },
  });
  if (existing) {
    return { ok: false, message: "You have already voted on this decision." };
  }

  // The threshold follows the COMMITTEE'S configured size. `hasActiveCommittee`
  // only treats the committee as active once activeSeats >= committeeMajority(size),
  // so the threshold is always reachable here and a loan never strands.
  const activeSeats = await prisma.committeeMember.count({
    where: { committeeId: committee.id, active: true },
  });
  if (activeSeats === 0) {
    return { ok: false, message: `The *${committee.name}* has no seated members, so it can't decide.` };
  }

  await prisma.committeeVote.create({
    data: { decisionId: decision.id, memberId, vote: cleanVote },
  });

  const votes = await prisma.committeeVote.findMany({
    where: { decisionId: decision.id },
    select: { vote: true },
  });
  const approvals = votes.filter((v) => v.vote === "approve").length;
  const rejections = votes.filter((v) => v.vote === "reject").length;
  const majority = committeeMajority(committee.size);

  let decided: "approved" | "rejected" | undefined;
  if (approvals >= majority) {
    decided = "approved";
  } else if (rejections >= majority || approvals + rejections >= activeSeats) {
    // Enough rejections, or every seat has voted without a majority — approval
    // is no longer mathematically possible.
    decided = "rejected";
  }

  if (decided) {
    await prisma.committeeDecision.update({
      where: { id: decision.id },
      data: { status: decided, decidedAt: new Date() },
    });
  }

  await audit({
    cooperativeId: coopId,
    actorPhone: "system",
    actorId: memberId,
    actorRole: "committee",
    action: "committee.vote",
    targetType: subjectType,
    targetId: subjectId,
    detail: `${cleanVote} on ${subjectType} ${subjectId.slice(-6)} (${approvals}/${activeSeats} approve, ${rejections} reject)`,
  });

  const tally = `${approvals}/${activeSeats} approve · ${rejections} reject`;
  if (decided === "approved") {
    return {
      ok: true,
      decided,
      message: `✅ Vote recorded. The *${committee.name}* has approved this (${tally}).`,
    };
  }
  if (decided === "rejected") {
    return {
      ok: true,
      decided,
      message: `❌ Vote recorded. The *${committee.name}* has rejected this (${tally}).`,
    };
  }
  return {
    ok: true,
    message: `🗳️ Vote recorded (${tally}). *${majority}* approvals needed to decide.`,
  };
}
