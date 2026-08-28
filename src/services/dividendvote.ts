import { prisma } from "../lib/prisma.js";
import { audit } from "./audit.js";
import { getCoopConfig, updateCoopConfig } from "./coop-config.js";

const VOTE_DAYS = 7;
const REQUIRED_YES_PCT = 40;

export interface VoteResult {
  ok: boolean;
  message: string;
}

function activeMemberCountForVote(cooperativeId: string): Promise<number> {
  return prisma.member.count({ where: { cooperativeId, status: "active" } });
}

export async function startDividendVote(
  actor: { id: string; name: string; phone: string; role: string; cooperativeId: string },
  rateArg: string,
): Promise<VoteResult> {
  const rate = Number(rateArg);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 25) {
    return { ok: false, message: "Usage: *startvotediv <rate%>*, e.g. *startvotediv 8* for an 8% dividend rate vote." };
  }
  const activeOpen = await prisma.dividendVote.findFirst({
    where: { cooperativeId: actor.cooperativeId, status: "open" },
  });
  if (activeOpen) {
    return { ok: false, message: `A dividend-rate vote is already open (proposed ${activeOpen.proposedRate}%). Close it before opening another.` };
  }
  const config = await getCoopConfig(actor.cooperativeId);
  const lastRate = config.lastDividendRate;
  if (lastRate !== null && Math.abs(rate - lastRate) <= 5) {
    return { ok: false, message: `This rate (${rate}%) is within 5% of the last rate (${lastRate}%); no member vote is required — use *paydividend ${rate}* directly.` };
  }

  const expiresAt = new Date(Date.now() + VOTE_DAYS * 24 * 60 * 60 * 1000);
  const vote = await prisma.dividendVote.create({
    data: {
      cooperativeId: actor.cooperativeId,
      proposedRate: rate,
      openedById: actor.id,
      requiredYesPct: REQUIRED_YES_PCT,
      expiresAt,
      status: "open",
    },
  });
  await updateCoopConfig(actor.cooperativeId, { pendingDividendRate: rate } as any);
  await audit({
    cooperativeId: actor.cooperativeId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "dividend.vote_open",
    targetType: "dividendVote",
    targetId: vote.id,
    detail: `opened dividend-rate vote for ${rate}%`,
  });
  return {
    ok: true,
    message:
      `🗳️ *Dividend rate vote opened*\n\n` +
      `Proposed dividend rate: *${rate}%*\n` +
      `Voting closes: *${expiresAt.toLocaleDateString("en-GB")}*\n\n` +
      `Members, reply *votediv yes* or *votediv no*. A *${REQUIRED_YES_PCT}%* yes-vote among active members is needed to pass.`,
  };
}

export async function getOpenDividendVote(cooperativeId: string) {
  return prisma.dividendVote.findFirst({ where: { cooperativeId, status: "open" } });
}

export async function castDividendVote(
  member: { id: string; name: string; phone: string; cooperativeId: string },
  choiceArg: string,
): Promise<VoteResult> {
  const vote = await getOpenDividendVote(member.cooperativeId);
  if (!vote) {
    return { ok: false, message: "There is no open dividend-rate vote right now." };
  }
  const choice = choiceArg?.toLowerCase();
  if (choice !== "yes" && choice !== "no") {
    return { ok: false, message: "Usage: *votediv yes* or *votediv no*." };
  }
  if (vote.expiresAt.getTime() < Date.now()) {
    await prisma.dividendVote.update({ where: { id: vote.id }, data: { status: "closed" } });
    return { ok: false, message: "That dividend-rate vote has expired." };
  }
  const existing = await prisma.dividendVoteBallot.findUnique({
    where: { voteId_memberId: { voteId: vote.id, memberId: member.id } },
  });
  if (existing) {
    return { ok: false, message: "You've already voted in this dividend-rate ballot. Reply *votedivstatus* to see the tally." };
  }
  await prisma.$transaction([
    prisma.dividendVoteBallot.create({
      data: { voteId: vote.id, memberId: member.id, choice: choice === "yes" },
    }),
    prisma.dividendVote.update({
      where: { id: vote.id },
      data: choice === "yes" ? { yesVotes: { increment: 1 } } : { noVotes: { increment: 1 } },
    }),
  ]);
  return {
    ok: true,
    message: choice === "yes"
      ? `✅ Your *yes* vote for a ${vote.proposedRate}% dividend rate has been recorded.`
      : `🗳️ Your *no* vote for a ${vote.proposedRate}% dividend rate has been recorded.`,
  };
}

export async function dividendVoteStatus(
  cooperativeId: string,
): Promise<VoteResult> {
  const latest = await prisma.dividendVote.findFirst({
    where: { cooperativeId },
    orderBy: { createdAt: "desc" },
    include: { openedBy: { select: { name: true } } },
  });
  if (!latest) {
    return { ok: false, message: "No dividend-rate vote has been held yet." };
  }
  const active =
    latest.status === "open"
      ? ` (open — closes ${latest.expiresAt.toLocaleDateString("en-GB")})`
      : ` (${latest.status})`;
  return {
    ok: true,
    message:
      `🗳️ *Dividend-rate vote status*${active}\n\n` +
      `Proposed rate: *${latest.proposedRate}%*\n` +
      `Yes: *${latest.yesVotes}* · No: *${latest.noVotes}*\n` +
      `Opened by: ${latest.openedBy.name}\n` +
      `Pass threshold: *${latest.requiredYesPct}%* of active members must vote yes.`,
  };
}

export async function closeDividendVote(
  actor: { id: string; name: string; phone: string; role: string; cooperativeId: string },
  decision: string | undefined,
): Promise<VoteResult> {
  const vote = await prisma.dividendVote.findFirst({
    where: { cooperativeId: actor.cooperativeId, status: "open" },
  });
  if (!vote) {
    return { ok: false, message: "There is no open dividend-rate vote to close." };
  }
  const action = decision?.toLowerCase();

  if (action === "reject") {
    await prisma.$transaction([
      prisma.dividendVote.update({ where: { id: vote.id }, data: { status: "rejected", closedById: actor.id, closedAt: new Date() } }),
      prisma.cooperativeConfig.update({
        where: { cooperativeId: actor.cooperativeId },
        data: { pendingDividendRate: null },
      }),
    ]);
    await audit({
      cooperativeId: actor.cooperativeId,
      actorPhone: actor.phone,
      actorId: actor.id,
      actorRole: actor.role,
      action: "dividend.vote_reject",
      targetType: "dividendVote",
      targetId: vote.id,
      detail: `rejected ${vote.proposedRate}% dividend-rate proposal`,
    });
    return { ok: true, message: `The ${vote.proposedRate}% dividend-rate proposal was *rejected*. No dividend at this rate.` };
  }

  const activeCount = await activeMemberCountForVote(actor.cooperativeId);
  const yesPct = activeCount > 0 ? Math.round((vote.yesVotes / activeCount) * 100) : 0;
  const passed = action === "approve" || (vote.yesVotes > 0 && yesPct >= vote.requiredYesPct);

  await prisma.$transaction([
    prisma.dividendVote.update({
      where: { id: vote.id },
      data: { status: passed ? "approved" : "rejected", closedById: actor.id, closedAt: new Date() },
    }),
    prisma.cooperativeConfig.update({
      where: { cooperativeId: actor.cooperativeId },
      data: passed ? { pendingDividendRate: vote.proposedRate } : { pendingDividendRate: null },
    }),
  ]);
  await audit({
    cooperativeId: actor.cooperativeId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role,
    action: passed ? "dividend.vote_approved" : "dividend.vote_failed",
    targetType: "dividendVote",
    targetId: vote.id,
    detail: `${vote.proposedRate}% proposal ${passed ? "approved" : "failed"} (yes ${vote.yesVotes}/${activeCount} = ${yesPct}%)`,
  });

  if (passed) {
    return {
      ok: true,
      message:
        `✅ The ${vote.proposedRate}% dividend rate was *approved* by members (${yesPct}% yes).\n\n` +
        `The super admin can now distribute with *paydividend ${vote.proposedRate}*.`,
    };
  }
  return {
    ok: true,
    message: `The ${vote.proposedRate}% dividend-rate proposal did not reach the yes threshold (${yesPct}% of ${activeCount} active members) and was not approved.`,
  };
}
