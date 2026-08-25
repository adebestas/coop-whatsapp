import { prisma } from "../lib/prisma.js";

const STATUS_TIPS = [
  "💡 Save before you spend. Even ₦500/day = ₦182,500/year.",
  "💡 Your cooperative savings earn dividends. The more you save, the more you earn.",
  "💡 Compound interest rewards patience — start early!",
  "💡 An emergency fund of 3-6 months can save you from disaster.",
  "💡 Good debt makes you richer, bad debt makes you poorer.",
  "💡 Track every naira — small leaks sink big ships.",
  "💡 The best time to start investing was yesterday. The second best time is now.",
  "💡 Never invest in something you don't understand.",
  "💡 Diversify your income — don't rely on one source.",
  "💡 If inflation is 15% and savings earn 5%, you're actually losing 10%.",
  "💡 Save at least 20% of your income every month.",
  "💡 Your cooperative is your financial power — use it wisely.",
  "💡 Borrow what you need, not what you can get.",
  "💡 A strong cooperative = strong members.",
  "💡 Financial discipline today = financial freedom tomorrow.",
  "💡 Your loan limit is tied to your savings — save more, borrow more.",
  "💡 The reserve fund protects everyone's savings — it's not admin money.",
  "💡 Guaranteeing a loan is real financial trust — choose carefully.",
  "💡 Mark your repayment date somewhere you'll actually see it.",
  "💡 Keep contributing even while repaying a loan — it keeps your account healthy.",
];

const LESSON_TEASERS = [
  "📘 *Coming tomorrow:* How our loan system works. Reply CLASS to start learning now.",
  "📘 *Coming tomorrow:* What the reserve fund is for. Reply CLASS to start learning now.",
  "📘 *Coming tomorrow:* Being a guarantor — what it really means. Reply CLASS to start learning now.",
  "📘 *Coming tomorrow:* Avoiding loan default. Reply CLASS to start learning now.",
  "📘 *Today's lesson:* Why save regularly. Reply CLASS to start your financial journey.",
];

function getStatusForHour(hour: number): string {
  const today = new Date();
  const dayOfMonth = today.getDate();

  if (hour === 8) {
    return STATUS_TIPS[dayOfMonth % STATUS_TIPS.length];
  }
  if (hour === 12) {
    return STATUS_TIPS[(dayOfMonth + 10) % STATUS_TIPS.length];
  }
  if (hour === 18) {
    return LESSON_TEASERS[dayOfMonth % LESSON_TEASERS.length];
  }
  return STATUS_TIPS[0];
}

export async function postAutoStatus(): Promise<void> {
  const now = new Date();
  const hour = now.getHours();

  if (hour !== 8 && hour !== 12 && hour !== 18) {
    return;
  }

  const content = getStatusForHour(hour);

  // Post to all cooperatives with status enabled
  const cooperatives = await prisma.cooperative.findMany({
    select: { id: true },
  });

  for (const coop of cooperatives) {
    const existing = await prisma.statusPost.findFirst({
      where: {
        cooperativeId: coop.id,
        scheduledTime: {
          gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
          lt: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
        },
      },
    });

    if (existing) continue;

    await prisma.statusPost.create({
      data: {
        cooperativeId: coop.id,
        content,
        scheduledTime: now,
        postedAt: now,
      },
    });
  }
}

export async function getStatusPosts(cooperativeId: string): Promise<string[]> {
  const today = new Date();
  const posts = await prisma.statusPost.findMany({
    where: {
      cooperativeId,
      scheduledTime: {
        gte: new Date(today.getFullYear(), today.getMonth(), today.getDate()),
        lt: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1),
      },
    },
    orderBy: { scheduledTime: "asc" },
  });

  return posts.map((p) => p.content);
}

export function startStatusScheduler(): void {
  setInterval(postAutoStatus, 60 * 60 * 1000); // Check every hour
}
