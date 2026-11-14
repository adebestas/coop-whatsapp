/**
 * Structured JSON logger with optional off-box error forwarding.
 *
 * Every line is a single JSON object on stdout (info/warn/debug) or stderr
 * (error), so a log drain can parse it. When ERROR_WEBHOOK_URL is set, errors
 * are also POSTed to it (Slack/Discord-compatible payload) — this is the
 * off-box channel for system-level failures that have no cooperative context
 * (webhook signature failures, unhandled rejections, scheduler crashes).
 *
 * Forwarding is best-effort: it never throws and never blocks the caller.
 */

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export type LogLevel = keyof typeof LOG_LEVELS;
const CURRENT_LOG_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";

// Log metadata is the easiest place to leak PII and credentials by accident.
// Key names that end in a sensitive term are replaced wholesale; the message
// text is left alone so operators can still describe what happened.
const SENSITIVE_KEY =
  /(phone|pin|token|secret|password|authorization|bvn|nin|account\w*|otp|totp)$/i;

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(val, seen);
  }
  return out;
}

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LOG_LEVELS[level] > LOG_LEVELS[CURRENT_LOG_LEVEL]) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    pid: process.pid,
    ...(meta ? { meta: redact(meta) } : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

function forwardError(message: string, meta?: Record<string, unknown>): void {
  const url = process.env.ERROR_WEBHOOK_URL;
  if (!url) return;
  const text = `🚨 ${message}${meta ? `\n${JSON.stringify(meta)}` : ""}`;
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `text` for Slack, `content` for Discord — harmless extra key otherwise.
    body: JSON.stringify({ text, content: text }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {
    /* never throw from logging */
  });
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => {
    emit("error", msg, meta);
    forwardError(msg, meta);
  },
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
};
