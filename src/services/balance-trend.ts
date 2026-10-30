import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";

const SPARK_BLOCKS = [" ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export interface MonthSavings {
  label: string; // e.g. "May"
  year: number;
  month: number; // 0-11
  totalKobo: number;
}

export interface BalanceTrendResult {
  months: MonthSavings[];
  sparkline: string;
  totalKobo: number;
  growthPct: number | null;
  bestMonth: MonthSavings | null;
}

/**
 * Calculates a member's monthly savings trend over the last 6 calendar months
 * and generates a visual Unicode sparkline chart.
 */
export async function getBalanceTrendData(
  memberId: string,
  cooperativeId: string,
  now = new Date(),
): Promise<BalanceTrendResult> {
  // Build the last 6 months buckets (chronological order)
  const buckets: MonthSavings[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleString("en-NG", { month: "short" });
    buckets.push({
      label,
      year: d.getFullYear(),
      month: d.getMonth(),
      totalKobo: 0,
    });
  }

  const startDate = new Date(buckets[0].year, buckets[0].month, 1);

  const contributions = await prisma.contribution.findMany({
    where: {
      memberId,
      cooperativeId,
      status: "confirmed",
      paidAt: { gte: startDate },
    },
    select: { amount: true, paidAt: true },
  });

  for (const c of contributions) {
    if (!c.paidAt) continue;
    const itemDate = new Date(c.paidAt);
    const bucket = buckets.find(
      (b) => b.year === itemDate.getFullYear() && b.month === itemDate.getMonth(),
    );
    if (bucket) {
      bucket.totalKobo += c.amount;
    }
  }

  const maxKobo = Math.max(...buckets.map((b) => b.totalKobo), 0);
  const totalKobo = buckets.reduce((acc, b) => acc + b.totalKobo, 0);

  // Render sparkline
  const sparklineParts = buckets.map((b) => {
    if (maxKobo === 0 || b.totalKobo === 0) {
      return `${b.label}  `;
    }
    const ratio = b.totalKobo / maxKobo;
    const blockIndex = Math.min(
      SPARK_BLOCKS.length - 1,
      Math.floor(ratio * (SPARK_BLOCKS.length - 1)),
    );
    return `${b.label} ${SPARK_BLOCKS[blockIndex]}`;
  });
  const sparkline = sparklineParts.join("  ");

  // Month-over-month growth (last month vs month before)
  const currentMonth = buckets[buckets.length - 1];
  const prevMonth = buckets[buckets.length - 2];
  let growthPct: number | null = null;
  if (prevMonth && prevMonth.totalKobo > 0) {
    growthPct = Math.round(
      ((currentMonth.totalKobo - prevMonth.totalKobo) / prevMonth.totalKobo) * 100,
    );
  } else if (currentMonth.totalKobo > 0) {
    growthPct = 100;
  }

  // Best month
  let bestMonth: MonthSavings | null = null;
  if (maxKobo > 0) {
    bestMonth = buckets.reduce((prev, curr) => (curr.totalKobo > prev.totalKobo ? curr : prev));
  }

  return {
    months: buckets,
    sparkline,
    totalKobo,
    growthPct,
    bestMonth,
  };
}

/**
 * Returns formatted chat representation of the member's savings trend.
 */
export async function getBalanceTrend(
  memberId: string,
  cooperativeId: string,
  now = new Date(),
): Promise<string> {
  const trend = await getBalanceTrendData(memberId, cooperativeId, now);

  let out = `📊 *Your 6-Month Savings Trend*\n\n`;
  out += `${trend.sparkline}\n\n`;
  out += `• Total saved (last 6 months): *${formatBalance(trend.totalKobo)}*\n`;

  if (trend.growthPct !== null) {
    const sign = trend.growthPct >= 0 ? "+" : "";
    out += `• Recent momentum: *${sign}${trend.growthPct}%* vs previous month\n`;
  }

  if (trend.bestMonth && trend.bestMonth.totalKobo > 0) {
    out += `• 🔥 Best month: *${trend.bestMonth.label}* (${formatBalance(trend.bestMonth.totalKobo)})\n`;
  }

  out += `\n_Keep the momentum going — reply *save <amount>* anytime!_`;
  return out;
}
