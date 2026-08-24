/**
 * Structured logger for production log aggregation.
 * Uses pino for high-performance JSON logging.
 */

import pino from "pino";

const isTest = process.env.NODE_ENV === "test";
const isDev = process.env.NODE_ENV === "development";

// Create structured logger
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isTest ? "silent" : isDev ? "debug" : "info"),
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
  // Redact sensitive fields from logs
  redact: {
    paths: [
      "pin",
      "password",
      "token",
      "secret",
      "otp",
      "totpSecret",
      "prevHash",
      "hash",
      "rawBody",
    ],
    censor: "[REDACTED]",
  },
});

// ===== Child Loggers for Specific Modules =====

/**
 * Create a child logger with context (e.g., module name, user ID)
 */
export function createLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

// ===== Predefined Child Loggers =====

export const webhookLogger = logger.child({ module: "webhook" });
export const paymentLogger = logger.child({ module: "payment" });
export const adminLogger = logger.child({ module: "admin" });
export const schedulerLogger = logger.child({ module: "scheduler" });
export const securityLogger = logger.child({ module: "security" });

// ===== Logging Helpers =====

/**
 * Log a security event (failed login, suspicious activity, etc.)
 */
export function logSecurityEvent(
  event: string,
  details: Record<string, unknown>,
  severity: "info" | "warn" | "error" = "warn",
) {
  logger[severity]({ ...details, securityEvent: true }, `[SECURITY] ${event}`);
}

/**
 * Log a financial transaction
 */
export function logTransaction(
  action: string,
  details: Record<string, unknown>,
) {
  logger.info({ ...details, transaction: true }, `[TRANSACTION] ${action}`);
}

/**
 * Log an API call
 */
export function logApiCall(
  provider: string,
  method: string,
  path: string,
  details: Record<string, unknown> = {},
) {
  logger.info({ provider, method, path, ...details }, `[API] ${provider} ${method} ${path}`);
}

/**
 * Log an error with context
 */
export function logError(
  error: unknown,
  context: Record<string, unknown> = {},
) {
  if (error instanceof Error) {
    logger.error({ err: error, ...context }, error.message);
  } else {
    logger.error({ error, ...context }, "Unknown error");
  }
}
