import { claimOnce } from "./cache.js";
import { alertDevelopers } from "./alerting.js";

const TIME_ZONE = "Africa/Lagos";
const BUSINESS_START_HOUR = 6;
const BUSINESS_END_HOUR = 22;

/** ₦10,000 by default; override with ALERT_WALLET_THRESHOLD_KOBO. */
export function walletAlertThresholdKobo(): number {
  const raw = Number(process.env.ALERT_WALLET_THRESHOLD_KOBO);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_000_000;
}

export function isOutsideBusinessHours(now = new Date()): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE,
      hour: "numeric",
      hour12: false,
    }).format(now),
  );
  return hour < BUSINESS_START_HOUR || hour >= BUSINESS_END_HOUR;
}

const SENSITIVE_ADMIN_ACTIONS = new Set(["admin.wallet.adjust", "role.set"]);

/**
 * Business-hours and value checks for privileged actions. Called from the audit
 * choke point so it covers every caller of `audit()` without route plumbing.
 */
export async function evaluateAdminAction(input: {
  action: string;
  actorPhone: string;
  amount?: number | null;
  now?: Date;
}): Promise<string[]> {
  if (!SENSITIVE_ADMIN_ACTIONS.has(input.action)) return [];
  const reasons: string[] = [];
  if (isOutsideBusinessHours(input.now)) reasons.push("outside 06:00-22:00 Africa/Lagos");
  if (
    input.amount !== null &&
    input.amount !== undefined &&
    input.amount >= walletAlertThresholdKobo()
  ) {
    reasons.push(
      `amount ₦${(input.amount / 100).toLocaleString("en-NG")} at/above alert threshold`,
    );
  }
  if (reasons.length === 0) return [];

  const hourBucket = Math.floor((input.now ?? new Date()).getTime() / 3_600_000);
  const key = `${input.action}:${input.actorPhone}:${hourBucket}`;
  if (await claimOnce("admin-action-anomaly", key, 3_600)) {
    await alertDevelopers(
      `Sensitive action ${input.action} by ${input.actorPhone}: ${reasons.join("; ")}`,
    );
  }
  return reasons;
}

/** A lockout is a security event in its own right: always alerted, one per hour. */
export async function alertLockout(surface: string, subject: string, ip: string): Promise<void> {
  if (await claimOnce("lockout-alert", `${surface}:${subject}`, 3_600)) {
    await alertDevelopers(`Login lockout on ${surface} for ${subject} (last IP ${ip})`);
  }
}

/** Magic-link reuse or an expired/link-guessing attempt. */
export async function alertMagicLinkReplay(surface: string, ip: string): Promise<void> {
  if (await claimOnce("magic-link-replay", `${surface}:${ip}`, 600)) {
    await alertDevelopers(`Magic-link consume rejected on ${surface} from ${ip}`);
  }
}
