import { prisma } from "../lib/prisma.js";
import { formatBalance } from "../lib/money.js";
import { quorumMet } from "./meetings.js";
import { buildLiveResultsMessage, buildTallyMessage, countActiveMembers } from "./votes.js";

export type LiveTrendKind = "election" | "buy" | "dividend" | "motion";

export interface LiveTrendResult {
  ok: boolean;
  message: string;
  kind?: LiveTrendKind;
  voteId?: string;
}

const BAR_WIDTH = 10;

/** Bar scaled to the leading tally, matching the election live-results style. */
export function progressBar(votes: number, maxVotes: number): string {
  if (maxVotes <= 0) return "░".repeat(BAR_WIDTH);
  const filled = Math.min(BAR_WIDTH, Math.round((votes / maxVotes) * BAR_WIDTH));
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function voteWord(n: number): string {
  return n === 1 ? "vote" : "votes";
}

/** "Leading: *X* (n votes)", or an honest tie / empty state. */
export function leaderLabel(options: Array<{ label: string; votes: number }>): string {
  const total = options.reduce((sum, o) => sum + o.votes, 0);
  if (total === 0) return "Leading: _no votes yet_";
  const max = Math.max(...options.map((o) => o.votes));
  const leaders = options.filter((o) => o.votes === max);
  if (leaders.length !== 1) return `Leading: *tied* (${max} ${voteWord(max)} each)`;
  return `Leading: *${leaders[0].label}* (${max} ${voteWord(max)})`;
}

/** Turnout against the eligible pool (active members, or present attendees). */
export function votersLabel(voters: number, eligible?: number, pool = "active"): string {
  if (!eligible || eligible <= 0) return `Voters: ${voters}`;
  const pct = Math.round((voters / eligible) * 100);
  return `Voters: ${voters} of ${eligible} ${pool} (${pct}%)`;
}

function optionLine(
  label: string,
  votes: number,
  maxVotes: number,
  total: number,
  note?: string,
): string {
  const pct = total > 0 ? Math.round((votes / total) * 100) : 0;
  const noteText = note ? ` — ${note}` : "";
  return `${label}${noteText}: ${progressBar(votes, maxVotes)} ${votes} ${voteWord(votes)} (${pct}%)`;
}

export interface BuyPollTrendInput {
  id: string;
  title: string;
  status: string;
  options: Array<{ label: string; votes: number; note?: string }>;
  voters: number;
  eligible: number;
  includeFooter?: boolean;
}

/** Live tally for a buy-vote (what the cooperative should buy). */
export function buildBuyPollTrend(poll: BuyPollTrendInput): string {
  const total = poll.options.reduce((sum, o) => sum + o.votes, 0);
  const max = Math.max(...poll.options.map((o) => o.votes), 0);
  const lines = poll.options.map(
    (o, i) => `${i + 1}. ${optionLine(o.label, o.votes, max, total, o.note)}`,
  );
  const open = poll.status === "open";
  const footer =
    poll.includeFooter === false
      ? []
      : [
          open
            ? `Status: Open — vote with *votebuy ${poll.id.slice(-6)} <option #>*.`
            : `Status: ${poll.status}`,
        ];
  return [
    `🛒 *Buy-vote: ${poll.title}* — ${open ? "live" : poll.status}`,
    "",
    lines.join("\n") || "_No options yet._",
    "",
    leaderLabel(poll.options),
    votersLabel(poll.voters, poll.eligible),
    ...footer,
  ].join("\n");
}

export interface DividendTrendInput {
  id: string;
  proposedRate: number;
  status: string;
  yes: number;
  no: number;
  requiredYesPct: number;
  expiresAt: Date;
  voters: number;
  eligible: number;
  includeFooter?: boolean;
}

/** Live tally for the yes/no dividend-rate governance vote. */
export function buildDividendTrend(vote: DividendTrendInput): string {
  const total = vote.yes + vote.no;
  const max = Math.max(vote.yes, vote.no, 0);
  const open = vote.status === "open";
  const yesShare = vote.eligible > 0 ? Math.round((vote.yes / vote.eligible) * 100) : 0;
  const thresholdMet = vote.eligible > 0 && yesShare >= vote.requiredYesPct;
  const lines = [optionLine("Yes", vote.yes, max, total), optionLine("No", vote.no, max, total)];
  const footer =
    vote.includeFooter === false
      ? []
      : [
          `Pass threshold: *${vote.requiredYesPct}%* of active members must vote yes — now *${vote.yes}/${vote.eligible} (${yesShare}%)* ${thresholdMet ? "✅" : "❌"}`,
          open
            ? `Closes: ${vote.expiresAt.toLocaleDateString("en-GB")} · Vote id *${vote.id.slice(-6)}*`
            : `Status: ${vote.status} · Vote id *${vote.id.slice(-6)}*`,
        ];
  return [
    `📊 *Dividend-rate vote: ${vote.proposedRate}%* — ${open ? "live" : vote.status}`,
    "",
    lines.join("\n"),
    "",
    leaderLabel([
      { label: "yes", votes: vote.yes },
      { label: "no", votes: vote.no },
    ]),
    votersLabel(vote.voters, vote.eligible),
    ...footer,
  ].join("\n");
}

export interface MotionTrendInput {
  id: string;
  title: string;
  status: string;
  yes: number;
  no: number;
  abstain: number;
  present: number;
  eligible: number;
  required: number;
  quorumMet: boolean;
  includeFooter?: boolean;
}

/** Live tally for a meeting motion (yes / no / abstain). */
export function buildMotionTrend(motion: MotionTrendInput): string {
  const total = motion.yes + motion.no + motion.abstain;
  const max = Math.max(motion.yes, motion.no, motion.abstain, 0);
  const open = motion.status === "open";
  const lines = [
    optionLine("Yes", motion.yes, max, total),
    optionLine("No", motion.no, max, total),
    optionLine("Abstain", motion.abstain, max, total),
  ];
  const footer =
    motion.includeFooter === false
      ? []
      : [
          `Quorum: ${motion.present}/${motion.eligible} present, ${motion.required} required — ${
            motion.quorumMet ? "✅ met" : "❌ not met"
          }`,
          open
            ? `Status: Open — closes when an admin runs *closemotion ${motion.id.slice(-6)}*.`
            : `Status: ${motion.status}`,
        ];
  return [
    `🗳️ *Motion: ${motion.title}* — ${open ? "live" : motion.status}`,
    "",
    lines.join("\n"),
    "",
    leaderLabel([
      { label: "yes", votes: motion.yes },
      { label: "no", votes: motion.no },
      { label: "abstain", votes: motion.abstain },
    ]),
    votersLabel(total, motion.present, "present"),
    ...footer,
  ].join("\n");
}

function idFilter(clean: string) {
  return clean.length >= 20 ? { id: clean } : { id: { endsWith: clean } };
}

async function buyTrend(cooperativeId: string, pollId: string): Promise<LiveTrendResult> {
  const poll = await prisma.purchasePoll.findFirst({
    where: { id: pollId, cooperativeId },
    include: {
      options: {
        orderBy: { createdAt: "asc" },
        include: { _count: { select: { ballots: true } } },
      },
      _count: { select: { ballots: true } },
    },
  });
  if (!poll) return { ok: false, message: "Buy-vote not found." };
  const eligible = await countActiveMembers(cooperativeId, null);
  return {
    ok: true,
    kind: "buy",
    voteId: poll.id,
    message: buildBuyPollTrend({
      id: poll.id,
      title: poll.title,
      status: poll.status,
      options: poll.options.map((o) => ({
        label: o.name,
        votes: o._count.ballots,
        note: `~${formatBalance(o.estimatedCost)}`,
      })),
      voters: poll._count.ballots,
      eligible,
    }),
  };
}

async function dividendTrend(cooperativeId: string, voteId: string): Promise<LiveTrendResult> {
  const vote = await prisma.dividendVote.findFirst({
    where: { id: voteId, cooperativeId },
    include: { ballots: { select: { choice: true } } },
  });
  if (!vote) return { ok: false, message: "Dividend-rate vote not found." };
  const yes = vote.ballots.filter((b) => b.choice).length;
  const no = vote.ballots.filter((b) => !b.choice).length;
  const eligible = await countActiveMembers(cooperativeId, null);
  return {
    ok: true,
    kind: "dividend",
    voteId: vote.id,
    message: buildDividendTrend({
      id: vote.id,
      proposedRate: vote.proposedRate,
      status: vote.status,
      yes,
      no,
      requiredYesPct: vote.requiredYesPct,
      expiresAt: vote.expiresAt,
      voters: yes + no,
      eligible,
    }),
  };
}

async function motionTrend(cooperativeId: string, motionId: string): Promise<LiveTrendResult> {
  const motion = await prisma.motion.findFirst({
    where: { id: motionId, cooperativeId },
    include: { votes: { select: { choice: true } } },
  });
  if (!motion) return { ok: false, message: "Motion not found." };
  const yes = motion.votes.filter((v) => v.choice === "yes").length;
  const no = motion.votes.filter((v) => v.choice === "no").length;
  const abstain = motion.votes.filter((v) => v.choice === "abstain").length;
  const quorum = await quorumMet(cooperativeId, motion.meetingId);
  return {
    ok: true,
    kind: "motion",
    voteId: motion.id,
    message: buildMotionTrend({
      id: motion.id,
      title: motion.title,
      status: motion.status,
      yes,
      no,
      abstain,
      present: quorum.present,
      eligible: quorum.eligible,
      required: quorum.required,
      quorumMet: quorum.met,
    }),
  };
}

/**
 * One live-trend lookup for every vote type a member can see: elections,
 * buy-votes, motions and dividend-rate votes. All lookups are scoped to the
 * caller's cooperative so a short id can never reveal another coop's ballot.
 */
export async function getLiveTrend(cooperativeId: string, ref: string): Promise<LiveTrendResult> {
  const clean = (ref ?? "").trim();
  if (!clean) {
    return {
      ok: false,
      message:
        "Usage: *livetrend <id>* — works for elections, buy-votes, motions and the open dividend-rate vote.",
    };
  }

  const where = idFilter(clean);
  const [votes, polls, motions, dividends] = await Promise.all([
    prisma.vote.findMany({ where: { cooperativeId, ...where }, select: { id: true }, take: 2 }),
    prisma.purchasePoll.findMany({
      where: { cooperativeId, ...where },
      select: { id: true },
      take: 2,
    }),
    prisma.motion.findMany({ where: { cooperativeId, ...where }, select: { id: true }, take: 2 }),
    prisma.dividendVote.findMany({
      where: { cooperativeId, ...where },
      select: { id: true },
      take: 2,
    }),
  ]);

  const matches: Array<{ kind: LiveTrendKind; id: string }> = [
    ...votes.map((row) => ({ kind: "election" as const, id: row.id })),
    ...polls.map((row) => ({ kind: "buy" as const, id: row.id })),
    ...motions.map((row) => ({ kind: "motion" as const, id: row.id })),
    ...dividends.map((row) => ({ kind: "dividend" as const, id: row.id })),
  ];

  if (matches.length === 0) {
    return {
      ok: false,
      message:
        "No vote matches that id. Find it with *elections*, *buypolls* or *motions <meeting id>*.",
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message:
        "That id matches more than one vote — send the full id, or use *pollresults*, *buypolls <id>* or *motions <meeting id>*.",
    };
  }

  const match = matches[0];
  if (match.kind === "election") {
    const vote = await prisma.vote.findFirst({
      where: { id: match.id, cooperativeId },
      select: { status: true },
    });
    return {
      ok: true,
      kind: "election",
      voteId: match.id,
      message:
        vote?.status === "open"
          ? await buildLiveResultsMessage(match.id)
          : await buildTallyMessage(match.id),
    };
  }
  if (match.kind === "buy") return buyTrend(cooperativeId, match.id);
  if (match.kind === "motion") return motionTrend(cooperativeId, match.id);
  return dividendTrend(cooperativeId, match.id);
}

/** Append the live tally to a "vote recorded" confirmation when available. */
export async function appendTrend(
  message: string,
  cooperativeId: string,
  ref: string | undefined,
): Promise<string> {
  if (!ref) return message;
  const trend = await getLiveTrend(cooperativeId, ref);
  return trend.ok ? `${message}\n\n${trend.message}` : message;
}
