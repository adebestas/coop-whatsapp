import { sendText } from "../../lib/messaging.js";
import { getMemberByPhone, formatBalance } from "../cooperative.js";
import {
  startVote,
  addCandidate,
  castVote,
  closeVote,
  showResults,
  memberElectionsMessage,
  countActiveMembers,
} from "../votes.js";
import { castBuyVote, listBuyPolls } from "../buypoll.js";
import { getLiveTrend, appendTrend, buildBuyPollTrend } from "../live-trends.js";

export async function handleStartVote(phone: string, args: string[]): Promise<void> {
  const kind = args[0]?.toLowerCase();
  const scope = args[1];
  const title = args.slice(2).join(" ");
  const result = await startVote(phone, kind ?? "", scope, title);
  await sendText({ to: phone, text: result.message });
}

export async function handleCandidate(phone: string, args: string[]): Promise<void> {
  const voteCode = args[0];
  const memberCode = args[1];
  if (!voteCode || !memberCode) {
    await sendText({ to: phone, text: "Usage: *candidate <election id> <member code>*" });
    return;
  }
  const result = await addCandidate(phone, voteCode, memberCode);
  await sendText({ to: phone, text: result.message });
}

export async function handleVote(phone: string, args: string[]): Promise<void> {
  const voteCode = args[0];
  const memberCode = args[1];
  if (!voteCode || !memberCode) {
    await sendText({ to: phone, text: "Usage: *vote <election id> <member code>*" });
    return;
  }
  const result = await castVote(phone, voteCode, memberCode);
  let text = result.message;
  if (result.ok) {
    const member = await getMemberByPhone(phone);
    if (member) text = await appendTrend(text, member.cooperativeId, voteCode);
  }
  await sendText({ to: phone, text });
}

export async function handleCloseVote(phone: string, args: string[]): Promise<void> {
  if (!args[0]) {
    await sendText({ to: phone, text: "Usage: *closevote <election id>*" });
    return;
  }
  const result = await closeVote(phone, args[0]);
  await sendText({ to: phone, text: result.message });
}

export async function handleResults(phone: string, args: string[]): Promise<void> {
  if (!args[0]) {
    await sendText({ to: phone, text: "Usage: *results <election id>*" });
    return;
  }
  const result = await showResults(phone, args[0]);
  await sendText({ to: phone, text: result.message });
}

export async function handleBuyPolls(phone: string, cooperativeId?: string): Promise<void> {
  const member = await getMemberByPhone(phone, cooperativeId);
  if (!member) {
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>*.",
    });
    return;
  }
  const polls = await listBuyPolls(member.cooperativeId);
  if (polls.length === 0) {
    await sendText({
      to: phone,
      text: "No buy-votes yet. Admins open one with *startbuyvote <title>*.",
    });
    return;
  }
  const eligible = await countActiveMembers(member.cooperativeId, null);
  const parts = polls.map((p) =>
    buildBuyPollTrend({
      id: p.id,
      title: p.title,
      status: p.status,
      options: p.options.map((o) => ({
        label: o.name,
        votes: o._count.ballots,
        note: `~${formatBalance(o.estimatedCost)}`,
      })),
      voters: p._count.ballots,
      eligible,
      includeFooter: false,
    }),
  );
  await sendText({
    to: phone,
    text:
      parts.join("\n\n---\n\n") +
      `\n\nVote with *votebuy <poll id> <option number>* · live tally: *livetrend <poll id>*.`,
  });
}

export async function handleVoteBuy(
  phone: string,
  args: string[],
  cooperativeId?: string,
): Promise<void> {
  const member = await getMemberByPhone(phone, cooperativeId);
  if (!member) {
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>*.",
    });
    return;
  }
  const pollCode = args[0];
  const optionNumber = Number(args[1]);
  if (!pollCode || !Number.isInteger(optionNumber) || optionNumber < 1) {
    await sendText({
      to: phone,
      text: "Usage: *votebuy <poll id> <option number>* — see options with *buypolls*.",
    });
    return;
  }
  const result = await castBuyVote(
    { id: member.id, cooperativeId: member.cooperativeId },
    pollCode,
    optionNumber,
  );
  let text = result.message;
  if (result.ok) {
    text = await appendTrend(text, member.cooperativeId, result.pollId ?? pollCode);
  }
  await sendText({ to: phone, text });
}

export async function handlePollResults(phone: string, args: string[]): Promise<void> {
  if (!args[0]) {
    await sendText({ to: phone, text: "Usage: *livetrend <election id>*" });
    return;
  }
  const result = await showLiveTrend(phone, args[0]);
  await sendText({ to: phone, text: result });
}

/** Any member can ask for the live tally of any open vote they can see. */
export async function handleLiveTrend(phone: string, args: string[]): Promise<void> {
  if (!args[0]) {
    await sendText({
      to: phone,
      text: "Usage: *livetrend <id>* — elections, buy-votes, motions and the open dividend-rate vote.",
    });
    return;
  }
  const result = await showLiveTrend(phone, args[0]);
  await sendText({ to: phone, text: result });
}

async function showLiveTrend(phone: string, ref: string): Promise<string> {
  const member = await getMemberByPhone(phone);
  if (!member) return "You need to join a cooperative first. Reply *join <code>*.";
  const trend = await getLiveTrend(member.cooperativeId, ref);
  return trend.message;
}

export async function handleElections(phone: string, cooperativeId?: string): Promise<void> {
  const member = await getMemberByPhone(phone, cooperativeId);
  if (!member) {
    await sendText({
      to: phone,
      text: "You need to join a cooperative first. Reply *join <code>*.",
    });
    return;
  }
  const text = await memberElectionsMessage(member.cooperativeId, member.unitId);
  await sendText({ to: phone, text });
}
