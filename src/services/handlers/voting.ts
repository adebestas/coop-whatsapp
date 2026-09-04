import { sendText } from "../../lib/messaging.js";
import { getMemberByPhone, formatBalance } from "../cooperative.js";
import { startVote, addCandidate, castVote, closeVote, showResults, showLiveResults, memberElectionsMessage } from "../votes.js";
import { castBuyVote, listBuyPolls } from "../buypoll.js";

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
  await sendText({ to: phone, text: result.message });
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

export async function handleBuyPolls(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const polls = await listBuyPolls(member.cooperativeId);
  if (polls.length === 0) {
    await sendText({ to: phone, text: "No buy-votes yet. Admins open one with *startbuyvote <title>*." });
    return;
  }
  const parts: string[] = [];
  for (const p of polls) {
    parts.push(
      `🛒 *${p.title}* (${p.status}) — id *${p.id.slice(-6)}*`,
      ...p.options.map((o, i) => `   ${i + 1}. ${o.name} — ~${formatBalance(o.estimatedCost)} — ${o._count.ballots} vote(s)`),
      "",
    );
  }
  await sendText({
    to: phone,
    text:
      parts.join("\n").trim() +
      `\n\nVote with *votebuy <poll id> <option number>*.`,
  });
}

export async function handleVoteBuy(phone: string, args: string[]): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const pollCode = args[0];
  const optionNumber = Number(args[1]);
  if (!pollCode || !Number.isInteger(optionNumber) || optionNumber < 1) {
    await sendText({ to: phone, text: "Usage: *votebuy <poll id> <option number>* — see options with *buypolls*." });
    return;
  }
  const result = await castBuyVote(
    { id: member.id, cooperativeId: member.cooperativeId },
    pollCode,
    optionNumber,
  );
  await sendText({ to: phone, text: result.message });
}

export async function handlePollResults(phone: string, args: string[]): Promise<void> {
  if (!args[0]) {
    await sendText({ to: phone, text: "Usage: *pollresults <election id>*" });
    return;
  }
  const result = await showLiveResults(phone, args[0]);
  await sendText({ to: phone, text: result.message });
}

export async function handleElections(phone: string): Promise<void> {
  const member = await getMemberByPhone(phone);
  if (!member) {
    await sendText({ to: phone, text: "You need to join a cooperative first. Reply *join <code>*." });
    return;
  }
  const text = await memberElectionsMessage(member.cooperativeId, member.unitId);
  await sendText({ to: phone, text });
}
