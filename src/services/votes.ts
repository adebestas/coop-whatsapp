import { prisma } from "../lib/prisma.js";
import { notifyMember } from "../lib/messaging.js";
import { audit } from "./audit.js";

const BROADCAST_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between broadcasts

export interface VoteResult {
  ok: boolean;
  message: string;
  voteId?: string;
}

async function countActiveMembers(cooperativeId: string, unitId: string | null): Promise<number> {
  const where: { cooperativeId: string; status: string; unitId?: string } = {
    cooperativeId,
    status: "active",
  };
  if (unitId) {
    where.unitId = unitId;
  }
  return prisma.member.count({ where });
}

function buildProgressBar(votes: number, maxVotes: number): string {
  if (maxVotes === 0) return "░░░░░░░░░░";
  const filled = Math.round((votes / maxVotes) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function tallyChannels(ballots: { channel?: string | null }[]): string {
  const counts: Record<string, number> = {};
  for (const b of ballots) {
    const ch = b.channel || "whatsapp";
    counts[ch] = (counts[ch] ?? 0) + 1;
  }
  const label: Record<string, string> = { whatsapp: "WhatsApp", telegram: "Telegram", web: "Web" };
  const parts = Object.entries(counts).map(([k, n]) => `${label[k] ?? k} (${n})`);
  return parts.length ? parts.join(", ") : "no votes yet";
}

function electionTypeLabel(vote: { electionType: string; kind: string; position?: string | null; unitId?: string | null }): string {
  if (vote.electionType === "workplace" || vote.kind === "unit") return "🏢 Workplace Election";
  if (vote.electionType === "executive" || vote.kind === "exec") return "🏛️ Executive Election";
  return "🗳️ General Vote";
}

function positionLabel(vote: { position?: string | null; title: string }): string {
  return vote.position ? ` for *${vote.position}*` : "";
}

async function buildLiveResultsMessage(voteId: string): Promise<string> {
  const vote = await prisma.vote.findUnique({
    where: { id: voteId },
    include: {
      candidates: {
        include: { member: { select: { name: true } }, ballots: { select: { id: true, channel: true } } },
      },
    },
  });
  if (!vote) return "Election not found.";

  const totalVotes = vote.candidates.reduce((sum, c) => sum + c.ballots.length, 0);
  const maxVotes = Math.max(...vote.candidates.map((c) => c.ballots.length), 1);
  const activeMembers = await countActiveMembers(vote.cooperativeId, vote.unitId);
  const quorumRequired = Math.ceil((activeMembers * vote.quorumRequired) / 100);
  const quorumMet = totalVotes >= quorumRequired;
  const quorumPercent = activeMembers > 0 ? Math.round((totalVotes / activeMembers) * 100) : 0;

  const channels = tallyChannels(vote.candidates.flatMap((c) => c.ballots));

  const lines = vote.candidates.map((c) => {
    const votes = c.ballots.length;
    const pct = totalVotes > 0 ? Math.round((votes / totalVotes) * 100) : 0;
    const bar = buildProgressBar(votes, maxVotes);
    return `${c.member.name}: ${bar} ${votes} vote${votes !== 1 ? "s" : ""} (${pct}%)`;
  });

  const quorumStatus = quorumMet ? "✅" : "❌";
  // Votes are closed manually (no end time), so no valid countdown exists —
  // show an honest status rather than a misleading "Ended" from the start time.
  const typeTag = electionTypeLabel(vote);
  const posLabel = positionLabel(vote);

  return (
    `${typeTag} LIVE: ${vote.title}${posLabel}\n\n` +
    `${lines.join("\n") || "No candidates yet."}\n\n` +
    `Total votes: ${totalVotes} | Quorum: ${totalVotes}/${quorumRequired} (${quorumPercent}%) ${quorumStatus}\n` +
    `Voting: ${channels} | One person, one vote\n` +
    `Status: Open — closes when an admin runs *closevote ${vote.id.slice(-6)}*`
  );
}

async function broadcastLiveResults(voteId: string): Promise<void> {
  const vote = await prisma.vote.findUnique({ where: { id: voteId } });
  if (!vote || vote.status !== "open") return;

  const now = new Date();
  if (vote.lastResultBroadcastAt) {
    const elapsed = now.getTime() - vote.lastResultBroadcastAt.getTime();
    if (elapsed < BROADCAST_COOLDOWN_MS) return;
  }

  const message = await buildLiveResultsMessage(voteId);

  const members = await prisma.member.findMany({
    where: {
      cooperativeId: vote.cooperativeId,
      status: "active",
      ...(vote.unitId ? { unitId: vote.unitId } : {}),
    },
    select: { phone: true, altChannelId: true, preferredChannel: true },
  });

  for (const member of members) {
    await notifyMember(member, message);
  }

  await prisma.vote.update({
    where: { id: voteId },
    data: { lastResultBroadcastAt: now },
  });
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
  let position: string | null;
  let electionType: string;
  let voteTitle: string;

  if (kind === "unit") {
    electionType = "workplace";
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
    position = `Admin — ${unit.name}`;
    voteTitle = title.trim() || `Admin for ${unit.name}`;
  } else {
    electionType = "executive";
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
      electionType,
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

  const activeMembers = await countActiveMembers(actor.cooperativeId, unitId);
  const quorumRequired = Math.ceil((activeMembers * 30) / 100);

  return {
    ok: true,
    voteId: vote.id,
    message:
      `🗳️ Election *${vote.id.slice(-6)}* opened: *${voteTitle}*\n` +
      (kind === "unit"
        ? `🏢 Workplace election${position ? ` — ${position}` : ""}\nOnly members of that unit can stand and vote.\n`
        : `🏛️ Executive election — ${position ?? "cooperative-wide"}\nAll cooperative members can stand and vote.\n`) +
      `\n📊 Quorum: ${quorumRequired} votes needed (30% of ${activeMembers} active members)\n` +
      `\nAdd candidates: *candidate ${vote.id.slice(-6)} <member code>*\n` +
      `Members vote: *vote ${vote.id.slice(-6)} <member code>*\n` +
      `Check results: *pollresults ${vote.id.slice(-6)}*\n` +
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

/** A member casts their ballot for a candidate (by member code).
 *  Nominees ARE allowed to vote — one person, one ballot per election. */
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
      data: {
        voteId: vote.id,
        candidateId: candidate.id,
        voterId: voter.id,
        channel: voterPhone.startsWith("tg:") ? "telegram" : "whatsapp",
      },
    });
  } catch {
    return { ok: false, message: "You already voted in this election. One person, one vote." };
  }

  await broadcastLiveResults(vote.id);

  return { ok: true, message: `🗳️ Vote recorded for *${candidate.member.name}*. Thank you for participating.` };
}

/** Show live results (tallies without revealing individual ballots). */
export async function showResults(phone: string, voteCode: string): Promise<VoteResult> {
  const vote = await findVote(voteCode);
  if (!vote) return { ok: false, message: "Election not found." };
  return { ok: true, message: await tallyMessage(vote.id) };
}

/** Show formatted live results for an ongoing election (pollresults command). */
export async function showLiveResults(phone: string, voteCode: string): Promise<VoteResult> {
  const vote = await findVote(voteCode);
  if (!vote) return { ok: false, message: "Election not found." };
  if (vote.status !== "open") {
    return { ok: true, message: await tallyMessage(vote.id) };
  }
  return { ok: true, message: await buildLiveResultsMessage(vote.id) };
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

  const totalVotes = tally.reduce((sum, c) => sum + c.ballots.length, 0);
  const activeMembers = await countActiveMembers(vote.cooperativeId, vote.unitId);
  const quorumRequired = Math.ceil((activeMembers * vote.quorumRequired) / 100);
  const quorumMet = totalVotes >= quorumRequired;

  tally.sort((a, b) => b.ballots.length - a.ballots.length);
  const winner = tally[0];
  const tied = tally.filter((c) => c.ballots.length === winner.ballots.length).length > 1;

  await prisma.vote.update({
    where: { id: vote.id },
    data: { status: "closed", closedAt: new Date(), winnerId: tied ? null : winner.memberId },
  });

  let quorumMessage: string;
  if (quorumMet) {
    quorumMessage = `✅ Quorum met (${totalVotes} of ${quorumRequired} votes needed). Results are binding.`;
  } else {
    quorumMessage = `❌ Quorum not met (${totalVotes} of ${quorumRequired} votes needed). Results are advisory only.`;
  }

  let extra = "";
  if (!tied && quorumMet && (vote.kind === "unit" || vote.electionType === "workplace") && vote.unitId) {
    const unit = await prisma.unit.findUnique({ where: { id: vote.unitId } });
    if (unit) {
      await prisma.$transaction([
        prisma.unit.update({ where: { id: unit.id }, data: { adminMemberId: winner.memberId } }),
        prisma.member.update({ where: { id: winner.memberId }, data: { role: "admin" } }),
      ]);
      extra = `\n\n🎉 ${winner.member.name} is now the elected admin of *${unit.name}* (${unit.code}).`;
    }
  } else if (!tied && !quorumMet && (vote.kind === "unit" || vote.electionType === "workplace") && vote.unitId) {
    extra = `\n\n⚠️ Quorum was not met, so *${winner.member.name}* is NOT installed as ${vote.unitId ? "admin" : "executive"}. Per cooperative rules, the election must reach quorum to be binding — please conduct a fresh election.`;
  } else if (!tied && (vote.kind === "exec" || vote.electionType === "executive")) {
    extra = `\n\n🎉 ${winner.member.name} is elected *${vote.position ?? "executive"}*.`;
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

  const finalMessage = (await tallyMessage(vote.id)) + `\n\n${quorumMessage}` + extra;
  return { ok: true, message: finalMessage };
}

async function tallyMessage(voteId: string): Promise<string> {
  const vote = await prisma.vote.findUnique({
    where: { id: voteId },
    include: {
      candidates: {
        include: { member: { select: { name: true } }, ballots: { select: { id: true, channel: true } } },
      },
    },
  });
  if (!vote) return "Election not found.";
  const typeTag = electionTypeLabel(vote);
  const posLabel = positionLabel(vote);
  const totalVotes = vote.candidates.reduce((sum, c) => sum + c.ballots.length, 0);
  const channels = tallyChannels(vote.candidates.flatMap((c) => c.ballots));
  const lines = vote.candidates
    .map((c) => `• ${c.member.name} — ${c.ballots.length} vote(s)`)
    .join("\n");
  return (
    `${typeTag} *${vote.title}*${posLabel} (${vote.status})\n\n${lines || "No candidates yet."}` +
    `\n\nTotal votes: ${totalVotes}\nVoting: ${channels} | One person, one vote`
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

/** Get all active elections a member is eligible to vote in (for auto-notify on join). */
export async function getActiveElectionsForNewMember(
  cooperativeId: string,
  unitId: string | null,
): Promise<Array<{ id: string; title: string; position: string | null; electionType: string; kind: string; createdAt: Date }>> {
  const votes = await prisma.vote.findMany({
    where: {
      cooperativeId,
      status: "open",
      OR: [
        // Executive / coop-wide elections: all members can vote
        { unitId: null },
        // Workplace elections: only members of that unit
        ...(unitId ? [{ unitId }] : []),
      ],
    },
    select: { id: true, title: true, position: true, electionType: true, kind: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return votes;
}

/** Member-facing "elections" command: list open elections the member is
 *  eligible for, with live tallies. */
export async function memberElectionsMessage(cooperativeId: string, unitId: string | null): Promise<string> {
  const open = await prisma.vote.findMany({
    where: {
      cooperativeId,
      status: "open",
      OR: [
        { unitId: null },
        ...(unitId ? [{ unitId }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  if (open.length === 0) {
    return "There are no open elections right now. Check back later.";
  }
  const parts: string[] = [];
  for (const v of open) {
    parts.push(await buildLiveResultsMessage(v.id));
  }
  return `🗳️ *Open Elections*\n\n` + parts.join("\n\n---\n\n");
}
