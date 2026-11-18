import { notifyMember } from "./messaging.js";
import { prisma } from "./prisma.js";
import { maskId } from "./security.js";
import { log } from "./logger.js";
import { sendTelegramMessage } from "./telegram.js";

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
      console.error(`[Alert] Failed to notify super admin ${maskId(sa.phone)}:`, err);
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
    console.error(`[Alert] Failed to notify admin ${maskId(adminPhone)}:`, err);
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

/**
 * Alert the engineering/ops channel, not a cooperative's admins.
 *
 * `log.error` is forwarded to ERROR_WEBHOOK_URL (Slack/Discord compatible), so
 * that alone reaches a channel; OPS_ALERT_TELEGRAM_CHAT_ID adds a direct
 * Telegram ping for alerts that must not sit unread (e.g. money stuck in a
 * dead-letter queue). Never throws.
 */
export async function alertDevelopers(context: string, error?: unknown): Promise<void> {
  const detail =
    error instanceof Error ? `${error.name}: ${error.message}` : error ? String(error) : "";
  log.error(`[ops-alert] ${context}`, detail ? { error: detail } : undefined);

  const chatId = process.env.OPS_ALERT_TELEGRAM_CHAT_ID;
  if (!chatId) return;
  await sendTelegramMessage(chatId, `[ALERT] ${context}${detail ? `\n\n${detail}` : ""}`).catch(
    (err) => console.error("[Alert] Failed to reach ops Telegram chat:", err),
  );
}
