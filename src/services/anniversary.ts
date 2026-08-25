import { prisma } from "../lib/prisma.js";
import { notifyMember } from "../lib/messaging.js";
import { formatBalance } from "./cooperative.js";

function calculateYearsSince(date: Date, now: Date): number {
  const diffMs = now.getTime() - date.getTime();
  return Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000));
}

export async function getAnniversaryMessage(
  member: {
    id: string;
    name: string;
    createdAt: Date;
    wallet?: { totalSaved: number } | null;
  },
  now = new Date(),
): Promise<string> {
  const years = calculateYearsSince(member.createdAt, now);
  const totalSaved = member.wallet?.totalSaved ?? 0;

  const dividendEntries = await prisma.dividendEntry.findMany({
    where: { memberId: member.id, status: "paid" },
  });
  const totalDividends = dividendEntries.reduce((sum, e) => sum + e.amount, 0);

  const loanCount = await prisma.loan.count({
    where: { memberId: member.id, status: "disbursed" },
  });

  const lines = [
    `🎉 *Happy Anniversary, ${member.name}!*`,
    ``,
    `Today marks ${years} year${years > 1 ? "s" : ""} since you joined Lagos Workers Cooperative.`,
    ``,
    `In that time, you've:`,
    `• Saved ${formatBalance(totalSaved)}`,
    `• Earned ${formatBalance(totalDividends)} in dividends`,
    `• Been part of ${loanCount} loan disbursement${loanCount !== 1 ? "s" : ""}`,
    ``,
    `Thank you for being part of our family. Here's to many more years of financial growth together! 🙏`,
  ];

  return lines.join("\n");
}

export async function checkAnniversaries(now = new Date()): Promise<number> {
  const members = await prisma.member.findMany({
    where: {
      status: "active",
      optedOut: false,
      lastAnniversaryGreetedYear: {
        not: now.getFullYear(),
      },
    },
    include: { wallet: true },
  });

  let sent = 0;
  for (const m of members) {
    if (!m.createdAt) continue;
    if (m.createdAt.getMonth() !== now.getMonth() || m.createdAt.getDate() !== now.getDate()) continue;

    const years = calculateYearsSince(m.createdAt, now);
    if (years < 1) continue;

    const message = await getAnniversaryMessage(m, now);
    await notifyMember(m, message).catch(() => {});
    await prisma.member.update({
      where: { id: m.id },
      data: { lastAnniversaryGreetedYear: now.getFullYear() },
    });
    sent++;
  }
  return sent;
}
