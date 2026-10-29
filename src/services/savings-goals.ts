import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";

export interface GoalProjection {
  targetKobo: number;
  currentKobo: number;
  remainingKobo: number;
  monthsToTarget: number;
  projectedDate: Date;
  monthlyVelocityKobo: number;
  recommendedMonthlyKobo?: number;
  targetDate?: Date;
}

/**
 * Calculate how long it will take a member to reach a savings goal
 * based on their recent savings velocity, or how much they need to save
 * each month to reach a specific target date.
 */
export async function calculateGoalProjection(
  memberId: string,
  targetKobo: number,
  targetDateStr?: string,
  now = new Date(),
): Promise<string> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    include: { wallet: true },
  });

  if (!member) return "Member account not found.";

  const currentSavings = member.wallet?.balance ?? 0;
  if (currentSavings >= targetKobo) {
    return (
      `🎉 *Goal Already Reached!*\n\n` +
      `Your current savings of *${formatBalance(currentSavings)}* already exceeds your goal of *${formatBalance(targetKobo)}*.\n\n` +
      `Consider opening a locked fixed product (*products*) to lock in high yields!`
    );
  }

  const remainingKobo = targetKobo - currentSavings;

  // Determine member's monthly savings velocity over last 90 days
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const recentContributions = await prisma.contribution.aggregate({
    where: {
      memberId,
      status: "confirmed",
      paidAt: { gte: ninetyDaysAgo },
    },
    _sum: { amount: true },
  });

  const totalRecent = recentContributions._sum.amount ?? 0;
  let monthlyVelocity = Math.round(totalRecent / 3);

  // If no 90-day activity, check if they have an active auto-save plan
  if (monthlyVelocity <= 0 && member.autoSaveEnabled && member.autoSaveAmount) {
    monthlyVelocity =
      member.autoSaveInterval === "weekly" ? member.autoSaveAmount * 4 : member.autoSaveAmount;
  }

  // If still zero, assume a nominal minimum of ₦5,000/month (500,000 kobo)
  const isEstimatedRate = monthlyVelocity <= 0;
  if (isEstimatedRate) {
    monthlyVelocity = 500000;
  }

  const monthsNeeded = Math.ceil(remainingKobo / monthlyVelocity);
  const projectedDate = new Date(now.getFullYear(), now.getMonth() + monthsNeeded, 1);

  let out = `🎯 *Savings Goal Plan*\n\n`;
  out += `• Target Goal: *${formatBalance(targetKobo)}*\n`;
  out += `• Current Balance: *${formatBalance(currentSavings)}*\n`;
  out += `• Remaining: *${formatBalance(remainingKobo)}*\n\n`;

  const velocityLabel = isEstimatedRate
    ? `~${formatBalance(monthlyVelocity)}/month (estimated baseline)`
    : `${formatBalance(monthlyVelocity)}/month (based on recent history)`;

  out += `At your savings pace of *${velocityLabel}*:\n`;
  out += `📅 You will reach your goal in about *${monthsNeeded} month${monthsNeeded > 1 ? "s" : ""}* (${projectedDate.toLocaleString(
    "en-NG",
    { month: "long", year: "numeric" },
  )}).\n\n`;

  // Parse optional target date
  let parsedTargetDate: Date | null = null;
  if (targetDateStr) {
    const raw = targetDateStr.trim().toLowerCase();
    const match = raw.match(/([a-z]+)\s*(\d{4})?/);
    if (match) {
      const monthNames = [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec",
      ];
      const mIdx = monthNames.findIndex((m) => match[1].startsWith(m));
      if (mIdx !== -1) {
        const year = match[2]
          ? Number(match[2])
          : now.getFullYear() + (mIdx <= now.getMonth() ? 1 : 0);
        parsedTargetDate = new Date(year, mIdx, 1);
      }
    }
  }

  if (parsedTargetDate) {
    const monthsUntilTarget = Math.max(
      1,
      (parsedTargetDate.getFullYear() - now.getFullYear()) * 12 +
        (parsedTargetDate.getMonth() - now.getMonth()),
    );
    const requiredMonthly = Math.ceil(remainingKobo / monthsUntilTarget);
    const targetFormatted = parsedTargetDate.toLocaleString("en-NG", {
      month: "long",
      year: "numeric",
    });

    out += `💡 *To reach your goal by ${targetFormatted}* (${monthsUntilTarget} months):\n`;
    out += `Save *${formatBalance(requiredMonthly)}/month* (or *${formatBalance(
      Math.ceil(requiredMonthly / 4),
    )}/week*).\n\n`;
    out += `Set this up right now:\n*plan ${Math.round(requiredMonthly / 100)} monthly*`;
  } else {
    out += `💡 Tip: Reply *goal ${Math.round(targetKobo / 100)} Dec 2027* to target a specific date!`;
  }

  return out;
}
