import { prisma } from "../lib/prisma.js";
import { sendText } from "../lib/messaging.js";
import { audit } from "./audit.js";

export interface VoteResult {
  ok: boolean;
  message: string;
  voteId?: string;
}

/**
 * Voting engine for cooperative elections:
 *  - kind "unit": elects the admin of a workplace/unit (only that unit votes)
 *  - kind "exec": cooperative-wide election for an executive position
 * One member, one ballot per election. Closing tallies the ballots; a unit
 * election automatically installs the winner as unit admin.
 */
export async function startVote(
  actorPhone: string,
  kind: string,
  scopeArg: string | undefined,
  title: string,
): Promise<VoteResult> {
  const actor = await prisma.member.findFirst({
    where: { phone: actorPhone, role: { in: ["admin", "superadmin"] } },
  });
  if (!actor) {
    return { ok: false, message: "Only an admin can start an election." };
  }
  if (kind !== "unit" && kind !== "exec") {
    return {
      ok: false,
      message: "Usage: *startvote unit <unitcode> <title>* or *startvote exec <position> <title>*.",
    };
  }

  let unitId: string | null = null;
  let position: string | null = null;
  let voteTitle = "";

  if (kind === "unit") {
    if (!scopeArg) {
      return { ok: false, message: "Usage: *startvote unit <unitcode> <title>*." };
    }
    const unit = await prisma.unit.findUnique({
      where: {
        cooperativeId_code: { cooperativeId: actor.cooperativeId, code: scopeArg.trim().toUpperCase() },
      },
    });
    if (!unit) return { ok: false, message: `No unit with code *${scopeArg}* in your cooperative.` };
    unitId = unit.id;
    voteTitle = title.trim() || `Unit admin election — ${unit.name}`;
  } else {
    if (!scopeArg) {
      return { ok: false, message: "Usage: *startvote exec <position> <title>* e.g. *startvote exec President Executive election 2026*." };
    }
    position = scopeArg.trim();
    voteTitle = title.trim() || `${position} election`;
  }

  // Only one open election per scope at a time.
  const open = await prisma.vote.findFirst({
    where: { cooperativeId: actor.cooperativeId, unitId, kind, status: "open" },
  });
  if (open) {
    return { ok: false, message: `There's already an open ${kind} election (*${open.id.slice(-6)}*). Close it first with *closevote ${open.id.slice(-6)}*.` };
  }

  const vote = await prisma.vote.create({
    data: {
      cooperativeId: actor.cooperativeId,
      unitId,
      kind,
      position,
      title: voteTitle.slice(0, 200),
      createdById: actor.id,
    },
  });

  await audit({
    cooperativeId: actor.cooperativeId,
    actorPhone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "vote.start",
    targetType: "vote",
    targetId: vote.id,
    detail: `${kind} — ${voteTitle}`,
  });

  return {
    ok: true,
    voteId: vote.id,
    message:
      `🗳️ Election *${vote.id.slice(-6)}* opened: *${voteTitle}*\n` +
      (kind === "unit" ? "Only members of that unit can stand and vote.\n" : "All cooperative members can stand and vote.\n") +
      `\nAdd candidates: *candidate ${vote.id.slice(-6)} <member code>*\n` +
      `Members vote: *vote ${vote.id.slice(-6)} <member code>*\n` +
      `Close & tally: *closevote ${vote.id.slice(-6)}*`,
  };
}

/** Admin adds a candidate to an open election. */
export async function addCandidate(actorPhone: string, voteCode: string, memberCode: string): Promise<VoteResult> {
  const actor = await prisma.member.findFirst({
    where: { phone: actorPhone, role: { in: ["admin", "superadmin"] } },
  });
  if (!actor) return { ok: false, message: "Only an admin can add candidates." };

  const vote = await findVote(voteCode);
  if (!vote || vote.cooperativeId !== actor.cooperativeId) return { ok: false, message: "Election not found." };
  if (vote.status !== "open") return { ok: false, message: "This election is closed." };

  const candidate = await prisma.member.findFirst({
    where: { cooperativeId: actor.cooperativeId, code: memberCode.trim().toUpperCase() },
  });
  if (!candidate) return { ok: false, message: `No member with code *${memberCode}* in your cooperative.` };
  if (vote.unitId && candidate.unitId !== vote.unitId) {
    return { ok: false, message: "Candidates for a unit election must belong to that unit." };
  }

  try {
    await prisma.voteCandidate.create({ data: { voteId: vote.id, memberId: candidate.id } });
  } catch {
    return { ok: false, message: `${candidate.name} is already a candidate.` };
  }
  return { ok: true, message: `✅ ${candidate.name} added as a candidate for *${vote.title}*.` };
}

/** A member casts their ballot for a candidate (by member code). */
export async function castVote(voterPhone: string, voteCode: string, memberCode: string): Promise<VoteResult> {
  const voter = await prisma.member.findFirst({ where: { phone: voterPhone } });
  if (!voter) return { ok: false, message: "You need to join a cooperative first." };

  const vote = await findVote(voteCode);
  if (!vote || vote.cooperativeId !== voter.cooperativeId) return { ok: false, message: "Election not found." };
  if (vote.status !== "open") return { ok: false, message: "This election is closed." };
  if (vote.unitId && voter.unitId !== vote.unitId) {
    return { ok: false, message: "Only members of this unit can vote in its election." };
  }

  const candidate = await prisma.voteCandidate.findFirst({
    where: {
      voteId: vote.id,
      member: { code: memberCode.trim().toUpperCase() },
    },
    include: { member: { select: { name: true } } },
  });
  if (!candidate) {
    return { ok: false, message: `That member isn't a candidate. Reply *results ${vote.id.slice(-6)}* to see the candidates.` };
  }

  try {
    await prisma.voteBallot.create({
      data: { voteId: vote.id, candidateId: candidate.id, voterId: voter.id },
    });
  } catch {
    return { ok: false, message: "You already voted in this election. One person, one vote." };
  }

  return { ok: true, message: `🗳️ Vote recorded for *${candidate.member.name}*. Thank you for participating.` };
}

/** Show live results (tallies without revealing individual ballots). */
export async function showResults(phone: string, voteCode: string): Promise<VoteResult> {
  const vote = await findVote(voteCode);
  if (!vote) return { ok: false, message: "Election not found." };
  return { ok: true, message: await tallyMessage(vote.id) };
}

/** Close an election and tally. Unit elections install the winner as unit admin. */
export async function closeVote(actorPhone: string, voteCode: string): Promise<VoteResult> {
  const actor = await prisma.member.findFirst({
    where: { phone: actorPhone, role: { in: ["admin", "superadmin"] } },
  });
  if (!actor) return { ok: false, message: "Only an admin can close an election." };

  const vote = await findVote(voteCode);
  if (!vote || vote.cooperativeId !== actor.cooperativeId) return { ok: false, message: "Election not found." };
  if (vote.status !== "open") return { ok: false, message: "This election is already closed." };

  const tally = await prisma.voteCandidate.findMany({
    where: { voteId: vote.id },
    include: { member: { select: { name: true } }, ballots: { select: { id: true } } },
  });
  if (tally.length === 0) {
    await prisma.vote.update({ where: { id: vote.id }, data: { status: "closed", closedAt: new Date() } });
    return { ok: true, message: "Election closed with no candidates. No winner." };
  }

  tally.sort((a, b) => b.ballots.length - a.ballots.length);
  const winner = tally[0];
  const tied = tally.filter((c) => c.ballots.length === winner.ballots.length).length > 1;

  await prisma.vote.update({
    where: { id: vote.id },
    data: { status: "closed", closedAt: new Date(), winnerId: tied ? null : winner.memberId },
  });

  let extra = "";
  if (!tied && vote.kind === "unit" && vote.unitId) {
    const unit = await prisma.unit.findUnique({ where: { id: vote.unitId } });
    if (unit) {
      await prisma.$transaction([
        prisma.unit.update({ where: { id: unit.id }, data: { adminMemberId: winner.memberId } }),
        prisma.member.update({ where: { id: winner.memberId }, data: { role: "admin" } }),
      ]);
      extra = `\n\n🎉 ${winner.member.name} is now the elected admin of *${unit.name}* (${unit.code}).`;
    }
  } else if (!tied && vote.kind === "exec") {
    extra = `\n\n🎉 ${winner.member.name} is elected *${vote.position}*.`;
  }

  await audit({
    cooperativeId: vote.cooperativeId,
    actorPhone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "vote.close",
    targetType: "vote",
    targetId: vote.id,
    detail: tied ? "tied result" : `winner: ${winner.member.name}`,
  });

  // Announce to voters/candidates' cooperative via the actors only (keep it light).
  return { ok: true, message: (await tallyMessage(vote.id)) + extra };
}

async function tallyMessage(voteId: string): Promise<string> {
  const vote = await prisma.vote.findUnique({
    where: { id: voteId },
    include: {
      candidates: {
        include: { member: { select: { name: true } }, ballots: { select: { id: true } } },
      },
    },
  });
  if (!vote) return "Election not found.";
  const lines = vote.candidates
    .map((c) => `• ${c.member.name} — ${c.ballots.length} vote(s)`)
    .join("\n");
  return (
    `🗳️ *${vote.title}* (${vote.status})\n\n${lines || "No candidates yet."}` +
    (vote.winnerId ? "" : "")
  );
}

async function findVote(shortId: string) {
  // Try exact match first
  const exact = await prisma.vote.findUnique({ where: { id: shortId } });
  if (exact) return exact;

  // Try suffix match — require exactly one result
  const matches = await prisma.vote.findMany({
    where: { id: { endsWith: shortId } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}
