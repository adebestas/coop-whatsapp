/**
 * Deterministic anomaly detection for the money-out path.
 *
 * This is the seed of "AI as an operating system": instead of only answering
 * questions, the platform proactively surfaces transactions that look wrong so
 * an admin can look. It is ADVISORY ONLY — it never blocks or reverses anything.
 *
 * The heuristics are deliberately simple and explainable (no LLM): a human must
 * be able to see why something was flagged.
 */

import { prisma } from "./prisma.js";

export interface Anomaly {
  kind: string;
  severity: "low" | "medium" | "high";
  detail: string;
  ref?: string;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Scan a cooperative's recent money movement for anomalies. Returns an empty
 * array when nothing looks unusual.
 */
export async function detectAnomalies(
  cooperativeId: string,
  now = new Date(),
): Promise<Anomaly[]> {
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const anomalies: Anomaly[] = [];

  // Baseline: median successful payout over 90 days.
  const baseline = await prisma.payout.findMany({
    where: { cooperativeId, status: "successful", createdAt: { gte: ninetyDaysAgo } },
    select: { amount: true },
  });
  const medianPayout = median(baseline.map((p) => p.amount));

  const recent = await prisma.payout.findMany({
    where: { cooperativeId, status: "successful", createdAt: { gte: sevenDaysAgo } },
    select: { id: true, amount: true, reference: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  // 1. Payouts far above the cooperative's typical payout.
  if (medianPayout > 0) {
    for (const p of recent) {
      if (p.amount > medianPayout * 3) {
        anomalies.push({
          kind: "large_payout",
          severity: p.amount > medianPayout * 6 ? "high" : "medium",
          detail: `Payout ${p.reference} of ${p.amount} kobo is ${(p.amount / medianPayout).toFixed(1)}x the median (${medianPayout} kobo).`,
          ref: p.id,
        });
      }
    }
  }

  // 2. Velocity: an unusual burst of payouts in 24h.
  const last24h = recent.filter((p) => p.createdAt >= oneDayAgo);
  if (last24h.length > 5) {
    anomalies.push({
      kind: "payout_velocity",
      severity: last24h.length > 10 ? "high" : "medium",
      detail: `${last24h.length} successful payouts in the last 24h.`,
    });
  }

  // 3. Manual credits — admin-created money is inherently notable.
  const manual = await prisma.manualCredit.findMany({
    where: { cooperativeId, createdAt: { gte: sevenDaysAgo } },
    select: { id: true, amount: true, narration: true, status: true },
  });
  for (const m of manual) {
    anomalies.push({
      kind: "manual_credit",
      severity: "medium",
      detail: `Manual credit of ${m.amount} kobo (${m.status}): ${m.narration}`,
      ref: m.id,
    });
  }

  return anomalies;
}

/** Human-readable summary for the admin chat command. */
export function formatAnomalies(anomalies: Anomaly[]): string {
  if (anomalies.length === 0) {
    return "✅ No anomalies detected in the last 7 days of money movement.";
  }
  const icon = { high: "🔴", medium: "🟠", low: "🟡" } as const;
  const lines = anomalies.map((a) => `${icon[a.severity]} *${a.kind}* — ${a.detail}`);
  return (
    `🔎 *Anomaly scan (advisory only)*\n\n` +
    lines.join("\n") +
    `\n\n_These are heuristics, not findings. Review before acting._`
  );
}
