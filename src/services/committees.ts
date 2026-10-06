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

/** Optional actor details for the audit trail (command layer supplies these). */
export interface CommitteeActor {
  phone?: string;
  id?: string | null;
  role?: string | null;
}

function actorFields(actor?: CommitteeActor) {
  return {
    actorPhone: actor?.phone ?? "system",
    actorId: actor?.id ?? undefined,
    actorRole: actor?.role ?? "system",
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
  actor?: CommitteeActor,
): Promise<CommitteeResult> {
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
  if (!Number.isFinite(cleanSize) || cleanSize < 1) {
    return { ok: false, message: "Committee size must be a positive number." };
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
  actor?: CommitteeActor,
): Promise<CommitteeResult> {
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
        appointedById: actor?.id ?? null,
        appointedAt: new Date(),
      },
    });
  } else {
    await prisma.committeeMember.create({
      data: {
        committeeId: committee.id,
        memberId: member.id,
        role: cleanRole,
        appointedById: actor?.id ?? null,
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
  actor?: CommitteeActor,
): Promise<CommitteeResult> {
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
