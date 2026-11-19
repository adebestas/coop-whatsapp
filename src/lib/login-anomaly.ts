import { prisma } from "./prisma.js";
import { claimOnce } from "./cache.js";
import { alertDevelopers } from "./alerting.js";
import type { LoginSurface } from "./login-lockout.js";

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const SEEN_IP_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Distinct accounts that must fail from one IP inside the window. */
export const STUFFING_DISTINCT_ACCOUNTS = 5;
/** Failures on one account before a success that is worth flagging. */
export const RECOVERY_FAILURES = 3;
/** One alert per signature per window, so a brute-force run cannot spam. */
const ALERT_THROTTLE_SECONDS = 15 * 60;

export interface AnomalyInput {
  surface: LoginSurface;
  phone: string;
  ip: string;
  /** id of the success attempt just recorded; excluded from history reads. */
  attemptId?: string;
}

export interface Anomaly {
  rule: "new_ip" | "credential_stuffing" | "recovery_after_failures";
  message: string;
}

/**
 * Rules that run only after a *successful* login. Failures are already covered
 * by the lockout ladder; the interesting signal is a success that does not look
 * like the account's normal pattern, or a success that ends a run of failures.
 * Returns the findings so tests (and callers) can assert without parsing logs.
 */
export async function evaluateLoginAnomalies(input: AnomalyInput): Promise<Anomaly[]> {
  const now = Date.now();
  const findings: Anomaly[] = [];

  const priorSuccessFromIp = await prisma.loginAttempt.count({
    where: {
      surface: input.surface,
      phone: input.phone,
      ip: input.ip,
      outcome: "success",
      createdAt: { gte: new Date(now - SEEN_IP_WINDOW_MS), lt: new Date(now - 60_000) },
      ...(input.attemptId ? { id: { not: input.attemptId } } : {}),
    },
  });
  if (priorSuccessFromIp === 0) {
    findings.push({
      rule: "new_ip",
      message: `first successful ${input.surface} sign-in for this account from ${input.ip}`,
    });
  }

  const recentFailuresFromIp = await prisma.loginAttempt.findMany({
    where: {
      surface: input.surface,
      ip: input.ip,
      outcome: { in: ["bad_credentials", "totp_failed"] },
      createdAt: { gte: new Date(now - FAILURE_WINDOW_MS) },
    },
    select: { phone: true },
    distinct: ["phone"],
  });
  if (recentFailuresFromIp.length >= STUFFING_DISTINCT_ACCOUNTS) {
    findings.push({
      rule: "credential_stuffing",
      message: `${recentFailuresFromIp.length} accounts failed from ${input.ip} in 15 minutes`,
    });
  }

  const priorFailures = await prisma.loginAttempt.count({
    where: {
      surface: input.surface,
      phone: input.phone,
      outcome: { in: ["bad_credentials", "totp_failed"] },
      createdAt: { gte: new Date(now - HISTORY_WINDOW_MS) },
    },
  });
  if (priorFailures >= RECOVERY_FAILURES) {
    findings.push({
      rule: "recovery_after_failures",
      message: `successful ${input.surface} sign-in after ${priorFailures} failed attempts in 24 hours`,
    });
  }

  for (const finding of findings) {
    const key = `${finding.rule}:${input.surface}:${input.phone}:${input.ip}`;
    if (await claimOnce("login-anomaly", key, ALERT_THROTTLE_SECONDS)) {
      await alertDevelopers(`Anomalous sign-in (${finding.rule}): ${finding.message}`);
    }
  }

  return findings;
}
