import { notifyMember } from "./messaging.js";
import { prisma } from "./prisma.js";

/**
 * Alert severity levels
 */
export enum AlertSeverity {
  INFO = "info",
  WARNING = "warning",
  CRITICAL = "critical",
}

/**
 * Send a critical alert to all super admins of a cooperative.
 * Uses the existing WhatsApp notification path.
 */
export async function alertSupers(
  cooperativeId: string,
  message: string,
  severity: AlertSeverity = AlertSeverity.CRITICAL,
): Promise<void> {
  const supers = await prisma.member.findMany({
    where: { cooperativeId, role: "superadmin", status: "active" },
    select: { phone: true, name: true },
  });

  const prefix =
    severity === AlertSeverity.CRITICAL ? "🚨" : severity === AlertSeverity.WARNING ? "⚠️" : "ℹ️";

  for (const sa of supers) {
    try {
      await notifyMember(
        { phone: sa.phone, altChannelId: null, preferredChannel: null },
        `${prefix} *${severity.toUpperCase()}*\n\n${message}`,
      );
    } catch (err) {
      console.error(`[Alert] Failed to notify super admin ${sa.phone}:`, err);
    }
  }
}

/**
 * Send a critical alert to a specific admin.
 */
export async function alertAdmin(
  adminPhone: string,
  message: string,
  severity: AlertSeverity = AlertSeverity.CRITICAL,
): Promise<void> {
  const prefix =
    severity === AlertSeverity.CRITICAL ? "🚨" : severity === AlertSeverity.WARNING ? "⚠️" : "ℹ️";

  try {
    await notifyMember(
      { phone: adminPhone, altChannelId: null, preferredChannel: null },
      `${prefix} *${severity.toUpperCase()}*\n\n${message}`,
    );
  } catch (err) {
    console.error(`[Alert] Failed to notify admin ${adminPhone}:`, err);
  }
}

/**
 * Log a structured error with context and optionally alert super admins.
 * Use this for money-path failures that require immediate attention.
 */
export async function logAndAlert(
  cooperativeId: string,
  context: string,
  error: Error | unknown,
  severity: AlertSeverity = AlertSeverity.CRITICAL,
): Promise<void> {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = `${context}\n\nError: ${err.message}\nStack: ${err.stack ?? "unavailable"}`;

  // Log structured error
  console.error(`[${severity.toUpperCase()}] ${context}`, {
    cooperativeId,
    error: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString(),
  });

  // Alert super admins
  await alertSupers(cooperativeId, message, severity);
}

/**
 * Wrapper for async operations in the money path.
 * On failure: logs structured error, alerts super admins, and re-throws.
 */
export async function withMoneyPathAlert<T>(
  cooperativeId: string,
  context: string,
  fn: () => Promise<T>,
  severity: AlertSeverity = AlertSeverity.CRITICAL,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await logAndAlert(cooperativeId, context, err, severity);
    throw err;
  }
}

/**
 * Wrapper for fire-and-forget notifications in the money path.
 * On failure: logs error and alerts super admins (does not re-throw).
 */
export async function notifyWithAlert(
  cooperativeId: string,
  context: string,
  fn: () => Promise<void>,
  severity: AlertSeverity = AlertSeverity.CRITICAL,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    await logAndAlert(cooperativeId, context, err, severity);
  }
}
