import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { audit } from "./audit.js";
import { requestExternalPayment } from "./payanyone.js";

export interface BuyPollResult {
  ok: boolean;
  message: string;
  pollId?: string;
  poll?: { id: string; title: string };
}

/**
 * Buy votes: members vote on what item the cooperative should buy for them.
 * The winning option auto-creates a pay-anyone request for the vendor, which
 * still needs 3 super admin approvals to move money.
 */
export async function startBuyPoll(
  actor: { id: string; phone: string; role: string; cooperativeId: string },
  title: string,
): Promise<BuyPollResult> {
  if (!title || title.length < 3) {
    return { ok: false, message: "Give it a title: *startbuyvote <title>* — e.g. *startbuyvote New office generator*." };
  }

  const open = await prisma.purchasePoll.findFirst({
    where: { cooperativeId: actor.cooperativeId, status: "open" },
  });
  if (open) {
    return { ok: false, message: `Poll *${open.id.slice(-6)}* ("${open.title}") is still open. Close it first with *closebuyvote ${open.id.slice(-6)}*.` };
  }

  const poll = await prisma.purchasePoll.create({
    data: { cooperativeId: actor.cooperativeId, title, createdById: actor.id },
  });

  await audit({
    cooperativeId: actor.cooperativeId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "buypoll.start",
    targetType: "purchase_poll",
    targetId: poll.id,
    detail: title,
  });

  return {
    ok: true,
    pollId: poll.id,
    message:
      `🛒 Buy-vote *${poll.id.slice(-6)}* opened: *${title}*\n\n` +
      `Add options: *addoption ${poll.id.slice(-6)} <item> <cost> <vendor account> <bank>*\n` +
      `Members vote: *votebuy ${poll.id.slice(-6)} <option number>*\n` +
      `Close & tally: *closebuyvote ${poll.id.slice(-6)}*\n\n` +
      `The winning item's purchase goes through the *3-super-admin* pay-anyone process.`,
  };
}

export async function addPollOption(
  actor: { id: string; phone: string; role: string; cooperativeId: string },
  shortId: string,
  name: string,
  cost: number,
  accountNumber?: string,
  bankCode?: string,
): Promise<BuyPollResult> {
  const poll = await findOpenPoll(actor.cooperativeId, shortId);
  if (!poll.ok) return poll;

  if (!name || !Number.isFinite(cost) || cost <= 0) {
    return { ok: false, message: "Use *addoption <poll id> <item> <cost> <account> <bank>* — e.g. *addoption abc123 Generator 450000 0123456789 GTB*." };
  }

  const count = await prisma.pollOption.count({ where: { pollId: poll.poll!.id } });
  if (count >= 10) {
    return { ok: false, message: "This poll already has 10 options." };
  }

  await prisma.pollOption.create({
    data: {
      pollId: poll.poll!.id,
      name,
      estimatedCost: cost,
      bankAccountNumber: accountNumber,
      bankCode: bankCode,
      createdById: actor.id,
    },
  });

  return {
    ok: true,
    message: `✅ Option added to *${poll.poll!.title}* (${count + 1} so far). Members vote with *votebuy ${poll.poll!.id.slice(-6)} <number>*.`,
  };
}

export async function castBuyVote(
  voter: { id: string; cooperativeId: string },
  shortId: string,
  optionNumber: number,
): Promise<BuyPollResult> {
  const poll = await prisma.purchasePoll.findFirst({
    where: {
      cooperativeId: voter.cooperativeId,
      OR: [{ id: shortId }, { id: { endsWith: shortId } }],
    },
    include: { options: { orderBy: { createdAt: "asc" } } },
  });
  if (!poll) return { ok: false, message: "Buy-vote not found. Check the id." };
  if (poll.status !== "open") return { ok: false, message: "This buy-vote is closed." };

  const option = poll.options[optionNumber - 1];
  if (!option) {
    return {
      ok: false,
      message: `Pick a number between 1 and ${poll.options.length}. See the options with *buypolls*.`,
    };
  }

  try {
    await prisma.pollBallot.create({
      data: { pollId: poll.id, optionId: option.id, voterId: voter.id },
    });
  } catch {
    return { ok: false, message: "You already voted in this buy-vote — one person, one vote." };
  }

  return {
    ok: true,
    message: `🗳️ Vote recorded for *${option.name}* (${formatBalance(option.estimatedCost)}). Thank you for participating.`,
  };
}

export async function closeBuyPoll(
  actor: { id: string; phone: string; role: string; cooperativeId: string },
  shortId: string,
): Promise<BuyPollResult> {
  const poll = await prisma.purchasePoll.findFirst({
    where: {
      cooperativeId: actor.cooperativeId,
      OR: [{ id: shortId }, { id: { endsWith: shortId } }],
    },
    include: {
      options: { include: { ballots: true } },
    },
  });
  if (!poll) return { ok: false, message: "Buy-vote not found." };
  if (poll.status === "closed") return { ok: false, message: "This buy-vote is already closed." };
  if (poll.options.length === 0) {
    return { ok: false, message: "No options were added — add some before closing." };
  }

  let winner = poll.options[0];
  for (const opt of poll.options) {
    if (opt.ballots.length > winner.ballots.length) winner = opt;
  }

  await prisma.$transaction([
    prisma.purchasePoll.update({
      where: { id: poll.id },
      data: { status: "closed", winnerOptionId: winner.id, closedAt: new Date() },
    }),
  ]);

  const tally = poll.options
    .map((o, i) => `• ${i + 1}. ${o.name} — ${o.ballots.length} vote(s)`)
    .join("\n");
  const summary =
    `🛒 *${poll.title}* (closed)\n\n${tally}\n\n` +
    `🏆 Winner: *${winner.name}* at ~${formatBalance(winner.estimatedCost)}.`;

  // Auto-create the pay-anyone request for the vendor (needs 3 supers).
  if (winner.bankAccountNumber && winner.bankCode) {
    const payment = await requestExternalPayment(
      { ...actor, name: actor.phone, cooperativeId: actor.cooperativeId },
      {
        beneficiaryName: `${winner.name} (vendor)`,
        accountNumber: winner.bankAccountNumber,
        bankCode: winner.bankCode,
        amount: winner.estimatedCost,
        purpose: `Buy-vote "${poll.title}" winning item`,
      },
    );
    await audit({
      cooperativeId: actor.cooperativeId,
      actorPhone: actor.phone,
      actorId: actor.id,
      actorRole: actor.role,
      action: "buypoll.close",
      targetType: "purchase_poll",
      targetId: poll.id,
      detail: `winner: ${winner.name}; payanyone: ${payment.paymentId?.slice(-6) ?? "n/a"}`,
    });
    return { ok: true, message: `${summary}\n\nA pay-anyone request was raised for it — it needs *3 super admin approvals*.` };
  }

  await audit({
    cooperativeId: actor.cooperativeId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "buypoll.close",
    targetType: "purchase_poll",
    targetId: poll.id,
    detail: `winner: ${winner.name} (no vendor account on file)`,
  });
  return {
    ok: true,
    message: `${summary}\n\nNo vendor account was attached to this option — raise the payment manually with *payanyone* when ready.`,
  };
}

/** Open/closed polls + their options and tallies, for display. */
export async function listBuyPolls(cooperativeId: string) {
  return prisma.purchasePoll.findMany({
    where: { cooperativeId },
    include: { options: { include: { _count: { select: { ballots: true } } } } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
}

function findOpenPoll(
  cooperativeId: string,
  shortId: string,
): Promise<BuyPollResult> {
  return prisma.purchasePoll
    .findFirst({
      where: {
        cooperativeId,
        status: "open",
        OR: [{ id: shortId }, { id: { endsWith: shortId } }],
      },
      select: { id: true, title: true },
    })
    .then((p) =>
      p
        ? { ok: true as const, message: "", poll: p }
        : { ok: false as const, message: "Open buy-vote not found. Check the id (or it's already closed)." },
    );
}
