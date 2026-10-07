import { prisma, withTx } from "../lib/prisma.js";
import { setCoopContext } from "../lib/tenant-context.js";
import type { Prisma } from "@prisma/client";
import { postJournal } from "./journal.js";
import { formatBalance } from "./cooperative.js";
import { audit } from "./audit.js";
import {
  LOAN_ADMIN_CHARGE,
  annualRateFor,
  calculateMonthlyPayment,
  totalRepayable,
} from "./loans.js";
import { LIMITS } from "../lib/money.js";

/** Regulatory ceiling on loan APR (CBN guidance), matching loans.ts. */
const GROUP_LOAN_MAX_RATE = 10;

export type GroupType = "rosca" | "vsla";

export interface GroupActor {
  id: string;
  phone: string;
  role?: string | null;
}

export interface GroupSummary {
  id: string;
  type: string;
  name: string;
  code: string;
  status: string;
  contributionAmount: number;
  cycleLength: number;
  memberCount: number;
}

const GROUP_TYPES = new Set<GroupType>(["rosca", "vsla"]);

function potAccount(groupId: string): string {
  return `liability:group_pot:${groupId}`;
}

function payoutAccount(memberId: string): string {
  return `liability:group_payout:${memberId}`;
}

/** Resolve a group by full id or a leading/trailing id suffix, scoped to a coop. */
async function resolveGroup(
  coopId: string,
  idOrSuffix: string,
  client: Prisma.TransactionClient = prisma as never,
) {
  if (!idOrSuffix) return null;
  return client.group.findFirst({
    where: {
      cooperativeId: coopId,
      OR: [
        { id: idOrSuffix },
        { id: { startsWith: idOrSuffix } },
        { id: { endsWith: idOrSuffix } },
      ],
    },
  });
}

/** Net pot balance for a group, derived from the double-entry journal. */
async function potForGroup(coopId: string, groupId: string): Promise<number> {
  const rows = await prisma.posting.groupBy({
    by: ["direction"],
    where: { entry: { cooperativeId: coopId }, account: potAccount(groupId) },
    _sum: { amount: true },
  });
  const credits = rows.find((r) => r.direction === "CREDIT")?._sum.amount ?? 0;
  const debits = rows.find((r) => r.direction === "DEBIT")?._sum.amount ?? 0;
  return credits - debits;
}

export async function createGroup(
  coopId: string,
  type: string,
  name: string,
  code: string,
  contributionAmount: number,
  cycleLength: number,
  actor: GroupActor,
): Promise<{ ok: boolean; message: string; groupId?: string; code?: string }> {
  const normalizedType = type.trim().toLowerCase() as GroupType;
  if (!GROUP_TYPES.has(normalizedType)) {
    return { ok: false, message: "Group type must be *rosca* or *vsla*." };
  }
  const groupName = name.trim();
  const groupCode = code.trim().toUpperCase();
  if (!groupName) return { ok: false, message: "Give the group a name." };
  if (!groupCode) return { ok: false, message: "Give the group a short code." };
  if (!Number.isInteger(contributionAmount) || contributionAmount <= 0) {
    return { ok: false, message: "Contribution amount must be a positive amount." };
  }
  if (!Number.isInteger(cycleLength) || cycleLength <= 0) {
    return { ok: false, message: "Cycle length must be a whole number of rounds." };
  }

  const existing = await prisma.group.findUnique({
    where: { cooperativeId_code: { cooperativeId: coopId, code: groupCode } },
  });
  if (existing) {
    return { ok: false, message: `A group with code *${groupCode}* already exists.` };
  }

  const group = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    const g = await tx.group.create({
      data: {
        cooperativeId: coopId,
        type: normalizedType,
        name: groupName,
        code: groupCode,
        contributionAmount,
        cycleLength,
        createdById: actor.id,
      },
    });
    await tx.groupCycle.create({
      data: { groupId: g.id, cooperativeId: coopId, cycleNumber: 1, status: "open" },
    });
    return g;
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role ?? null,
    action: "group.create",
    targetType: "group",
    targetId: group.id,
    detail: `${normalizedType.toUpperCase()} ${groupName} (${groupCode}) @ ${formatBalance(contributionAmount)} × ${cycleLength}`,
  }).catch(() => {});

  return {
    ok: true,
    message:
      `✅ Created ${normalizedType.toUpperCase()} group *${groupName}* (code *${groupCode}*).\n\n` +
      `• Contribution: *${formatBalance(contributionAmount)}* per round\n` +
      `• Cycle length: *${cycleLength}* rounds\n\n` +
      `Members join with *joingroup ${groupCode}*. Group ID: *${group.id}*`,
    groupId: group.id,
    code: group.code,
  };
}

export async function joinGroup(
  coopId: string,
  groupCode: string,
  memberId: string,
): Promise<{ ok: boolean; message: string; groupId?: string }> {
  const code = groupCode.trim().toUpperCase();
  const group = await prisma.group.findUnique({
    where: { cooperativeId_code: { cooperativeId: coopId, code } },
  });
  if (!group) return { ok: false, message: `No group found with code *${code}*.` };
  if (group.status !== "active") {
    return { ok: false, message: `The group *${group.name}* is closed.` };
  }

  const existing = await prisma.groupMember.findUnique({
    where: { groupId_memberId: { groupId: group.id, memberId } },
  });
  if (existing) {
    return { ok: false, message: "You are already a member of this group." };
  }

  const membership = await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);
    let rotationPosition: number | null = null;
    if (group.type === "rosca") {
      const highest = await tx.groupMember.aggregate({
        where: { groupId: group.id, rotationPosition: { not: null } },
        _max: { rotationPosition: true },
      });
      rotationPosition = (highest._max.rotationPosition ?? 0) + 1;
    }
    return tx.groupMember.create({
      data: { groupId: group.id, memberId, rotationPosition, shares: 0, active: true },
    });
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: "",
    actorId: memberId,
    action: "group.join",
    targetType: "group",
    targetId: group.id,
    detail: `Joined ${group.code}`,
  }).catch(() => {});

  const rotationNote =
    group.type === "rosca" && membership.rotationPosition
      ? `\nYour rotation position is *${membership.rotationPosition}*.`
      : "";
  return {
    ok: true,
    message: `✅ You joined the group *${group.name}*.${rotationNote}`,
    groupId: group.id,
  };
}

export async function contributeToGroup(
  coopId: string,
  groupId: string,
  memberId: string,
  amount: number,
): Promise<{
  ok: boolean;
  message: string;
  contributionId?: string;
  pot?: number;
  shares?: number;
}> {
  const group = await resolveGroup(coopId, groupId);
  if (!group) return { ok: false, message: "Group not found." };
  if (group.status !== "active") return { ok: false, message: "This group is closed." };
  if (!Number.isInteger(amount) || amount <= 0) {
    return { ok: false, message: "Enter a positive contribution amount." };
  }

  const membership = await prisma.groupMember.findUnique({
    where: { groupId_memberId: { groupId: group.id, memberId } },
  });
  if (!membership || !membership.active) {
    return { ok: false, message: "You are not a member of this group. Reply *joingroup <code>*." };
  }
  const contributingMember = await prisma.member.findUnique({
    where: { id: memberId },
    select: { name: true },
  });
  const contributorName = contributingMember?.name ?? "member";

  let shareDelta = 0;
  if (group.type === "rosca") {
    if (amount !== group.contributionAmount) {
      return {
        ok: false,
        message: `This ROSCA takes a fixed contribution of *${formatBalance(group.contributionAmount)}* per round.`,
      };
    }
  } else {
    if (amount % group.contributionAmount !== 0) {
      return {
        ok: false,
        message: `Contributions must be a multiple of *${formatBalance(group.contributionAmount)}* (1 share).`,
      };
    }
    shareDelta = amount / group.contributionAmount;
  }

  const cycle = await prisma.groupCycle.findFirst({
    where: { groupId: group.id, status: "open" },
    orderBy: { cycleNumber: "desc" },
  });
  if (!cycle) return { ok: false, message: "No open cycle for this group." };

  // A ROSCA round is a single fixed payment per member — reject a second one.
  if (group.type === "rosca") {
    const already = await prisma.groupContribution.findFirst({
      where: { cycleId: cycle.id, memberId },
    });
    if (already) {
      return { ok: false, message: "You have already contributed for this round." };
    }
  }

  const wallet = await prisma.wallet.findUnique({ where: { memberId } });
  if (!wallet) {
    return { ok: false, message: "You need an active wallet to contribute. Reply *join <code>*." };
  }
  const insufficientMessage =
    `Your wallet balance is *${formatBalance(wallet.balance)}*, less than the *${formatBalance(amount)}* contribution.\n\n` +
    `Reply *save <amount>* to top up first.`;
  if (wallet.balance < amount) {
    return { ok: false, message: insufficientMessage };
  }

  let contributionId = "";
  try {
    await withTx(async (tx) => {
      await setCoopContext(tx as never, coopId);
      // Move money out of the member's wallet into the group pot. The race
      // guard only debits while the wallet still covers the amount.
      const claimed = await tx.wallet.updateMany({
        where: { id: wallet.id, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (claimed.count === 0) throw new Error("INSUFFICIENT_BALANCE");
      const c = await tx.groupContribution.create({
        data: { groupId: group.id, cycleId: cycle.id, memberId, amount },
      });
      contributionId = c.id;
      if (shareDelta > 0) {
        await tx.groupMember.update({
          where: { id: membership.id },
          data: { shares: { increment: shareDelta } },
        });
      }
      // ROSCA: one fixed contribution per member per cycle, so the ref is
      // stable/idempotent. VSLA: members may buy shares more than once in a
      // cycle, so key the ref on the contribution row to stay unique.
      const txRef =
        group.type === "rosca" ? `grp_contrib_${cycle.id}_${memberId}` : `grp_contrib_${c.id}`;
      const posted = await postJournal(
        {
          cooperativeId: coopId,
          txRef,
          description: `Group contribution: ${contributorName} paid ${formatBalance(amount)} to ${group.code} cycle ${cycle.cycleNumber}`,
          postings: [
            { account: `member_wallet:${wallet.id}`, direction: "DEBIT", amount, memberId },
            { account: potAccount(group.id), direction: "CREDIT", amount },
          ],
        },
        tx as never,
      );
      if (!posted.posted) throw new Error(`group contribution journal not posted: ${posted.reason}`);
    });
  } catch (err) {
    if (err instanceof Error && err.message === "INSUFFICIENT_BALANCE") {
      return { ok: false, message: insufficientMessage };
    }
    throw err;
  }

  await audit({
    cooperativeId: coopId,
    actorPhone: "",
    actorId: memberId,
    action: "group.contribute",
    targetType: "group",
    targetId: group.id,
    amount,
    detail: `${contributorName} contributed ${formatBalance(amount)} to ${group.code} cycle ${cycle.cycleNumber}`,
  }).catch(() => {});

  const pot = await potForGroup(coopId, group.id);
  const shares = shareDelta > 0 ? membership.shares + shareDelta : membership.shares;
  const shareNote = shareDelta > 0 ? `\nYou now hold *${shares}* share(s).` : "";
  return {
    ok: true,
    message: `✅ Contributed *${formatBalance(amount)}* to *${group.name}*.${shareNote}`,
    contributionId,
    pot,
    shares,
  };
}

export async function closeGroupCycle(
  coopId: string,
  groupId: string,
  actor: GroupActor,
): Promise<{
  ok: boolean;
  message: string;
  cycleNumber?: number;
  payoutMemberId?: string | null;
  shareOutAmount?: number;
  payouts?: { memberId: string; amount: number }[];
  nextCycleNumber?: number;
}> {
  const group = await resolveGroup(coopId, groupId);
  if (!group) return { ok: false, message: "Group not found." };

  const cycle = await prisma.groupCycle.findFirst({
    where: { groupId: group.id, status: "open" },
    orderBy: { cycleNumber: "desc" },
  });
  if (!cycle) return { ok: false, message: "There is no open cycle to close." };

  const contributions = await prisma.groupContribution.findMany({ where: { cycleId: cycle.id } });
  const pot = contributions.reduce((s, c) => s + c.amount, 0);

  let payoutMemberId: string | null = null;
  const payouts: { memberId: string; amount: number }[] = [];

  await withTx(async (tx) => {
    await setCoopContext(tx as never, coopId);

    if (group.type === "rosca") {
      const members = await tx.groupMember.findMany({
        where: { groupId: group.id, active: true },
        orderBy: { rotationPosition: "asc" },
        include: { member: { select: { name: true } } },
      });
      const positioned = members.find((m) => m.rotationPosition === cycle.cycleNumber);
      const fallback =
        members.length > 0 ? members[(cycle.cycleNumber - 1) % members.length] : undefined;
      const beneficiary = positioned ?? fallback;
      if (beneficiary && pot > 0) {
        payoutMemberId = beneficiary.memberId;
        const wallet = await tx.wallet.findUnique({ where: { memberId: beneficiary.memberId } });
        if (wallet) {
          await tx.wallet.update({
            where: { id: wallet.id },
            data: { balance: { increment: pot } },
          });
        }
        const posted = await postJournal(
          {
            cooperativeId: coopId,
            txRef: `grp_payout_${cycle.id}`,
            description: `ROSCA payout: ${formatBalance(pot)} to ${beneficiary.member.name} — ${group.code} cycle ${cycle.cycleNumber}`,
            postings: [
              { account: potAccount(group.id), direction: "DEBIT", amount: pot },
              {
                account: wallet ? `member_wallet:${wallet.id}` : payoutAccount(beneficiary.memberId),
                direction: "CREDIT",
                amount: pot,
                memberId: beneficiary.memberId,
              },
            ],
          },
          tx as never,
        );
        if (!posted.posted) throw new Error(`rosca payout journal not posted: ${posted.reason}`);
      }
    } else {
      const members = await tx.groupMember.findMany({
        where: { groupId: group.id, active: true },
        orderBy: { rotationPosition: "asc" },
        include: { member: { select: { name: true } } },
      });
      const eligible = members.filter((m) => m.shares > 0);
      const totalShares = eligible.reduce((s, m) => s + m.shares, 0);
      if (pot > 0 && totalShares > 0) {
        // Largest-remainder method: floor each member's exact share of the pot,
        // then hand the leftover kobos to the largest fractional remainders so
        // the whole pot is distributed without rounding loss.
        const allocations = eligible.map((m) => ({
          member: m,
          amount: Math.floor((pot * m.shares) / totalShares),
          remainder: (pot * m.shares) % totalShares,
        }));
        let leftover = pot - allocations.reduce((s, a) => s + a.amount, 0);
        const byRemainder = [...allocations].sort((a, b) => b.remainder - a.remainder);
        for (const a of byRemainder) {
          if (leftover <= 0) break;
          a.amount += 1;
          leftover -= 1;
        }
        for (const a of allocations) {
          if (a.amount <= 0) continue;
          payouts.push({ memberId: a.member.memberId, amount: a.amount });
          const wallet = await tx.wallet.findUnique({ where: { memberId: a.member.memberId } });
          if (wallet) {
            await tx.wallet.update({
              where: { id: wallet.id },
              data: { balance: { increment: a.amount } },
            });
          }
          const posted = await postJournal(
            {
              cooperativeId: coopId,
              txRef: `grp_shareout_${cycle.id}_${a.member.id}`,
              description: `VSLA share-out: ${formatBalance(a.amount)} to ${a.member.member.name} — ${group.code} cycle ${cycle.cycleNumber}`,
              postings: [
                { account: potAccount(group.id), direction: "DEBIT", amount: a.amount },
                {
                  account: wallet ? `member_wallet:${wallet.id}` : payoutAccount(a.member.memberId),
                  direction: "CREDIT",
                  amount: a.amount,
                  memberId: a.member.memberId,
                },
              ],
            },
            tx as never,
          );
          if (!posted.posted) throw new Error(`vsla share-out journal not posted: ${posted.reason}`);
        }
        // VSLA members buy shares fresh each cycle, so redeem them now that the
        // pot has been shared out — otherwise cumulative shares would keep
        // earning against every later pot.
        await tx.groupMember.updateMany({ where: { groupId: group.id }, data: { shares: 0 } });
      }
    }

    await tx.groupCycle.update({
      where: { id: cycle.id },
      data: {
        status: "closed",
        endedAt: new Date(),
        payoutMemberId,
        shareOutAmount: pot,
      },
    });

    const hasNext = cycle.cycleNumber < group.cycleLength;
    if (hasNext) {
      await tx.groupCycle.create({
        data: {
          groupId: group.id,
          cooperativeId: coopId,
          cycleNumber: cycle.cycleNumber + 1,
          status: "open",
        },
      });
    } else {
      await tx.group.update({ where: { id: group.id }, data: { status: "closed" } });
    }
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role ?? null,
    action: "group.cycle_close",
    targetType: "group",
    targetId: group.id,
    amount: pot,
    detail: `${group.code} cycle ${cycle.cycleNumber} ${group.type.toUpperCase()} ${formatBalance(pot)} ${
      group.type === "rosca" ? `paid ${payoutMemberId ?? "n/a"}` : "share-out"
    }`,
  }).catch(() => {});

  const hasNext = cycle.cycleNumber < group.cycleLength;
  const summary =
    group.type === "rosca"
      ? `Payout of *${formatBalance(pot)}* to the next member in rotation.`
      : `Shared out *${formatBalance(pot)}* across ${payouts.length} member(s) by shares.`;
  return {
    ok: true,
    message:
      `✅ Closed cycle *${cycle.cycleNumber}* of *${group.name}*.\n\n${summary}` +
      (hasNext ? `\n\nCycle *${cycle.cycleNumber + 1}* is now open.` : "\n\nThe group has completed all rounds."),
    cycleNumber: cycle.cycleNumber,
    payoutMemberId,
    shareOutAmount: pot,
    payouts,
    nextCycleNumber: hasNext ? cycle.cycleNumber + 1 : undefined,
  };
}

/**
 * Apply for a joint-liability group loan. The group stands as the joint
 * guarantor, so a loan from an active group starts already `guaranteed` and
 * needs no individual guarantors before it can move through the approval chain.
 */
export async function applyGroupLoan(
  coopId: string,
  groupId: string,
  memberId: string,
  amount: number,
  months: number,
): Promise<{ ok: boolean; message: string; loanId?: string }> {
  const group = await resolveGroup(coopId, groupId);
  if (!group) return { ok: false, message: "Group not found." };
  if (group.status !== "active") {
    return { ok: false, message: `The group *${group.name}* is closed.` };
  }

  const membership = await prisma.groupMember.findUnique({
    where: { groupId_memberId: { groupId: group.id, memberId } },
  });
  if (!membership || !membership.active) {
    return { ok: false, message: "You are not a member of this group. Reply *joingroup <code>*." };
  }

  const applyingMember = await prisma.member.findUnique({
    where: { id: memberId },
    select: { name: true },
  });
  const applicantName = applyingMember?.name ?? "member";

  if (
    !Number.isInteger(amount) ||
    amount <= 0 ||
    !Number.isFinite(months) ||
    months < 1 ||
    months > 12
  ) {
    return {
      ok: false,
      message: "Use the format *grouploan <group id> <amount> <months>*, e.g. *grouploan abc123 50000 3* (up to 12 months).",
    };
  }
  if (amount < LIMITS.MIN_LOAN) {
    return { ok: false, message: `Minimum loan amount is *${formatBalance(LIMITS.MIN_LOAN)}*.` };
  }
  if (amount > LIMITS.MAX_LOAN) {
    return { ok: false, message: `Maximum loan amount is *${formatBalance(LIMITS.MAX_LOAN)}*.` };
  }

  // Joint liability: the group backs the loan, so it is not capped by the
  // individual member's savings the way a personal loan is.
  const interestRate = Math.min(annualRateFor(months), GROUP_LOAN_MAX_RATE);
  const monthly = calculateMonthlyPayment(amount, months);
  const total = totalRepayable(amount, months);

  const pendingCount = await prisma.loan.count({
    where: {
      cooperativeId: coopId,
      status: { in: ["pending", "guaranteed", "admin_approved", "super_approved_1"] },
    },
  });

  const loan = await prisma.loan.create({
    data: {
      amount,
      adminCharge: LOAN_ADMIN_CHARGE,
      interestRate,
      tenureMonths: months,
      // The group is the joint guarantor, so the loan is born guaranteed and
      // skips the individual-guarantor stage entirely.
      status: "guaranteed",
      balance: amount,
      memberId,
      cooperativeId: coopId,
      groupId: group.id,
      queuePosition: pendingCount + 1,
      queueJoinedAt: new Date(),
    },
  });

  await audit({
    cooperativeId: coopId,
    actorPhone: "",
    actorId: memberId,
    action: "group.loan_apply",
    targetType: "loan",
    targetId: loan.id,
    amount,
    detail: `Group ${group.code} joint-liability loan of ${formatBalance(amount)} applied by ${applicantName}`,
  }).catch(() => {});

  return {
    ok: true,
    loanId: loan.id,
    message:
      `✅ Group loan application received for *${group.name}*.\n\n` +
      `Amount: *${formatBalance(amount)}*\n` +
      `Tenure: *${months} months*\n` +
      `Interest: *${annualRateFor(months)}% APR* declining balance → repay *${formatBalance(Math.round(total))}*\n` +
      `Monthly installment: *${formatBalance(Math.round(monthly))}*\n\n` +
      `The group stands as *joint guarantor*, so no individual guarantors are needed. ` +
      `It now awaits officer approval.`,
  };
}

/** Group loans list for an admin — the joint-liability exposure of a group. */
export async function groupLoans(
  coopId: string,
  groupId: string,
): Promise<{
  ok: boolean;
  message: string;
  group?: { id: string; name: string; code: string; status: string };
  loans?: {
    id: string;
    memberId: string;
    memberName: string;
    amount: number;
    balance: number;
    status: string;
  }[];
}> {
  const group = await resolveGroup(coopId, groupId);
  if (!group) return { ok: false, message: "Group not found." };

  const loans = await prisma.loan.findMany({
    where: { groupId: group.id, cooperativeId: coopId },
    include: { member: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });

  return {
    ok: true,
    message: `${group.name}: ${loans.length} group loan(s).`,
    group: { id: group.id, name: group.name, code: group.code, status: group.status },
    loans: loans.map((l) => ({
      id: l.id,
      memberId: l.memberId,
      memberName: l.member.name,
      amount: l.amount,
      balance: l.balance,
      status: l.status,
    })),
  };
}

export async function listGroups(
  coopId: string,
): Promise<{ ok: boolean; message: string; groups?: GroupSummary[] }> {
  const groups = await prisma.group.findMany({
    where: { cooperativeId: coopId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { members: true } } },
  });
  return {
    ok: true,
    message: groups.length ? `${groups.length} group(s).` : "No savings groups yet.",
    groups: groups.map((g) => ({
      id: g.id,
      type: g.type,
      name: g.name,
      code: g.code,
      status: g.status,
      contributionAmount: g.contributionAmount,
      cycleLength: g.cycleLength,
      memberCount: g._count.members,
    })),
  };
}

export async function myGroups(
  coopId: string,
  memberId: string,
): Promise<{ ok: boolean; message: string; groups?: GroupSummary[] }> {
  const memberships = await prisma.groupMember.findMany({
    where: { memberId, group: { cooperativeId: coopId } },
    include: { group: { include: { _count: { select: { members: true } } } } },
  });
  return {
    ok: true,
    message: memberships.length ? `${memberships.length} group(s).` : "You have not joined any group.",
    groups: memberships.map((m) => ({
      id: m.group.id,
      type: m.group.type,
      name: m.group.name,
      code: m.group.code,
      status: m.group.status,
      contributionAmount: m.group.contributionAmount,
      cycleLength: m.group.cycleLength,
      memberCount: m.group._count.members,
    })),
  };
}

export async function groupStatus(
  coopId: string,
  groupId: string,
): Promise<{
  ok: boolean;
  message: string;
  group?: {
    id: string;
    type: string;
    name: string;
    code: string;
    status: string;
    contributionAmount: number;
    cycleLength: number;
  };
  members?: {
    memberId: string;
    name: string;
    rotationPosition: number | null;
    shares: number;
    active: boolean;
  }[];
  cycle?: { cycleNumber: number; status: string; startedAt: Date } | null;
  pot?: number;
  contributions?: number;
}> {
  const group = await resolveGroup(coopId, groupId);
  if (!group) return { ok: false, message: "Group not found." };

  const members = await prisma.groupMember.findMany({
    where: { groupId: group.id },
    include: { member: { select: { name: true } } },
    orderBy: [{ rotationPosition: "asc" }, { joinedAt: "asc" }],
  });
  const cycle = await prisma.groupCycle.findFirst({
    where: { groupId: group.id, status: "open" },
    orderBy: { cycleNumber: "desc" },
  });
  const pot = await potForGroup(coopId, group.id);
  const contributions = await prisma.groupContribution.count({ where: { groupId: group.id } });

  return {
    ok: true,
    message: `${group.name}: ${members.length} member(s), pot ${formatBalance(pot)}.`,
    group: {
      id: group.id,
      type: group.type,
      name: group.name,
      code: group.code,
      status: group.status,
      contributionAmount: group.contributionAmount,
      cycleLength: group.cycleLength,
    },
    members: members.map((m) => ({
      memberId: m.memberId,
      name: m.member.name,
      rotationPosition: m.rotationPosition,
      shares: m.shares,
      active: m.active,
    })),
    cycle: cycle
      ? { cycleNumber: cycle.cycleNumber, status: cycle.status, startedAt: cycle.startedAt }
      : null,
    pot,
    contributions,
  };
}
