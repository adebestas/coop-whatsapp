import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, createTestCoop, createTestMember, cleanupDatabase } from "./setup.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";
import {
  getLiveTrend,
  leaderLabel,
  progressBar,
  votersLabel,
  buildDividendTrend,
  buildMotionTrend,
} from "../src/services/live-trends.js";
import { startBuyPoll, addPollOption, castBuyVote } from "../src/services/buypoll.js";
import { startDividendVote, castDividendVote } from "../src/services/dividendvote.js";
import {
  addMotion,
  attendMeeting,
  castMotionVote,
  openMeeting,
  startMeeting,
} from "../src/services/meetings.js";

const SUPER = { phone: "2348090000001", role: "superadmin" as const };

function sentText(): string {
  return vi
    .mocked(sendText)
    .mock.calls.map((c) => c[0].text)
    .join("\n");
}

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanupDatabase();
});

describe("live trend formatting", () => {
  it("draws a bar scaled to the leader and never overflows", () => {
    expect(progressBar(0, 0)).toBe("░░░░░░░░░░");
    expect(progressBar(5, 10)).toBe("█████░░░░░");
    expect(progressBar(10, 10)).toBe("██████████");
    expect(progressBar(9, 1)).toBe("██████████");
  });

  it("names a single leader, calls a tie a tie, and handles no votes", () => {
    expect(leaderLabel([{ label: "A", votes: 0 }])).toBe("Leading: _no votes yet_");
    expect(leaderLabel([{ label: "A", votes: 2 }])).toBe("Leading: *A* (2 votes)");
    expect(
      leaderLabel([
        { label: "A", votes: 2 },
        { label: "B", votes: 2 },
      ]),
    ).toBe("Leading: *tied* (2 votes each)");
    expect(
      leaderLabel([
        { label: "A", votes: 1 },
        { label: "B", votes: 3 },
      ]),
    ).toBe("Leading: *B* (3 votes)");
  });

  it("shows turnout against the eligible pool", () => {
    expect(votersLabel(3)).toBe("Voters: 3");
    expect(votersLabel(3, 10)).toBe("Voters: 3 of 10 active (30%)");
    expect(votersLabel(2, 4, "present")).toBe("Voters: 2 of 4 present (50%)");
  });

  it("formats yes/no dividend and motion tallies from supplied counts", () => {
    const dividend = buildDividendTrend({
      id: "cmdivision1234567890",
      proposedRate: 8,
      status: "open",
      yes: 3,
      no: 1,
      requiredYesPct: 40,
      expiresAt: new Date("2026-12-01T00:00:00Z"),
      voters: 4,
      eligible: 10,
    });
    expect(dividend).toContain("Leading: *yes* (3 votes)");
    expect(dividend).toContain("Voters: 4 of 10 active (40%)");
    expect(dividend).toContain("Pass threshold");

    const motion = buildMotionTrend({
      id: "cmmotion1234567890",
      title: "Buy a generator",
      status: "open",
      yes: 2,
      no: 0,
      abstain: 1,
      present: 4,
      eligible: 8,
      required: 2,
      quorumMet: true,
    });
    expect(motion).toContain("Leading: *yes* (2 votes)");
    expect(motion).toContain("Voters: 3 of 4 present (75%)");
    expect(motion).toContain("✅ met");
  });
});

describe("live trend lookups and member replies", () => {
  it("shows voters and the leader for an open election, and after voting", async () => {
    const coop = await createTestCoop("LTR01");
    const admin = await createTestMember(coop.id, SUPER);
    const a = await createTestMember(coop.id, { phone: "2348011000001", name: "Ada Obi" });
    const b = await createTestMember(coop.id, { phone: "2348011000002", name: "Bola Ade" });
    const voter = await createTestMember(coop.id, { phone: "2348011000003", name: "Chidi Eze" });

    await handleMessage(admin.phone, "startvote exec President Trend election");
    const vote = await prisma.vote.findFirst({ where: { cooperativeId: coop.id } });
    const shortId = vote!.id.slice(-6);
    await handleMessage(admin.phone, `candidate ${shortId} ${a.code}`);
    await handleMessage(admin.phone, `candidate ${shortId} ${b.code}`);

    await handleMessage(voter.phone, `vote ${shortId} ${a.code}`);
    expect(sentText()).toContain("Vote recorded");
    expect(sentText()).toContain("Leading: *Ada Obi* (1 vote)");
    expect(sentText()).toContain("Voters: 1 of 4 active (25%)");

    vi.mocked(sendText).mockClear();
    await handleMessage(b.phone, `livetrend ${shortId}`);
    expect(sentText()).toContain("LIVE: trend election");
    expect(sentText()).toContain("Leading: *Ada Obi*");
    expect(sentText()).toContain("Voters: 1 of 4 active (25%)");

    const scoped = await getLiveTrend("some-other-coop", shortId);
    expect(scoped.ok).toBe(false);
  });

  it("shows a buy-vote leader, turnout and vote count after voting", async () => {
    const coop = await createTestCoop("LTR02");
    const admin = await createTestMember(coop.id, SUPER);
    const a = await createTestMember(coop.id, { phone: "2348011000011" });
    const b = await createTestMember(coop.id, { phone: "2348011000012" });
    const actor = { id: admin.id, phone: admin.phone, role: "superadmin", cooperativeId: coop.id };

    const started = await startBuyPoll(actor, "Office generator");
    expect(started.ok).toBe(true);
    const pollId = started.pollId!;
    await addPollOption(actor, pollId, "Industrial generator", 500000);
    await addPollOption(actor, pollId, "Small generator", 200000);
    expect((await castBuyVote({ id: a.id, cooperativeId: coop.id }, pollId, 1)).ok).toBe(true);
    expect((await castBuyVote({ id: b.id, cooperativeId: coop.id }, pollId, 2)).ok).toBe(true);

    const trend = await getLiveTrend(coop.id, pollId);
    expect(trend.ok).toBe(true);
    expect(trend.kind).toBe("buy");
    expect(trend.message).toContain("Leading: *tied* (1 vote each)");
    expect(trend.message).toContain("Voters: 2 of 3 active (67%)");

    vi.mocked(sendText).mockClear();
    await handleMessage(b.phone, `livetrend ${pollId.slice(-6)}`);
    expect(sentText()).toContain("Buy-vote: Office generator");
  });

  it("shows dividend-rate turnout, the leading side and the threshold", async () => {
    const coop = await createTestCoop("LTR03");
    const admin = await createTestMember(coop.id, SUPER);
    const voter = await createTestMember(coop.id, { phone: "2348011000021" });
    const second = await createTestMember(coop.id, { phone: "2348011000022" });
    const actor = { id: admin.id, phone: admin.phone, role: "superadmin", cooperativeId: coop.id };

    expect((await startDividendVote(actor, "8")).ok).toBe(true);
    const result = await castDividendVote(
      { id: voter.id, name: voter.name, phone: voter.phone, cooperativeId: coop.id },
      "yes",
    );
    expect(result.ok).toBe(true);
    expect(result.voteId).toBeTruthy();

    const trend = await getLiveTrend(coop.id, result.voteId!);
    expect(trend.ok).toBe(true);
    expect(trend.kind).toBe("dividend");
    expect(trend.message).toContain("Leading: *yes* (1 vote)");
    expect(trend.message).toContain("Voters: 1 of 3 active (33%)");
    expect(trend.message).toContain("Pass threshold");

    vi.mocked(sendText).mockClear();
    await handleMessage(second.phone, "votediv no");
    expect(sentText()).toContain("Your *no* vote");
    expect(sentText()).toContain("Leading: *tied* (1 vote each)");
    expect(sentText()).toContain("Voters: 2 of 3 active (67%)");
  });

  it("shows motion turnout and quorum in the live trend", async () => {
    const coop = await createTestCoop("LTR04");
    const admin = await createTestMember(coop.id, SUPER);
    const a = await createTestMember(coop.id, { phone: "2348011000031", name: "Ada Obi" });
    const b = await createTestMember(coop.id, { phone: "2348011000032", name: "Bola Ade" });
    const actor = { phone: admin.phone, id: admin.id, role: "superadmin" };

    const started = await startMeeting(coop.id, "agm", "Trend AGM", 50, actor);
    const meetingId = started.meetingId!;
    await openMeeting(coop.id, meetingId, actor);
    await attendMeeting(coop.id, meetingId, a.id);
    await attendMeeting(coop.id, meetingId, b.id);
    const motion = await addMotion(
      coop.id,
      meetingId,
      "Buy a generator",
      "Approve the purchase.",
      "general",
      actor,
    );
    expect(motion.ok).toBe(true);
    await castMotionVote(coop.id, motion.motionId!, a.id, "yes");

    const trend = await getLiveTrend(coop.id, motion.motionId!);
    expect(trend.ok).toBe(true);
    expect(trend.kind).toBe("motion");
    expect(trend.message).toContain("Leading: *yes* (1 vote)");
    expect(trend.message).toContain("Voters: 1 of 2 present (50%)");
    expect(trend.message).toContain("Quorum:");

    vi.mocked(sendText).mockClear();
    await handleMessage(a.phone, `livetrend ${motion.motionId!.slice(-6)}`);
    expect(sentText()).toContain("Motion: Buy a generator");
  });
});
