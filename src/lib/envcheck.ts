/**
 * Fail-fast configuration validation. Runs once at startup: the bot refuses
 * to start without its core secrets, and loudly lists which optional
 * integrations are missing so nobody discovers them at payout time.
 */

interface EnvSpec {
  key: string;
  fatal: boolean;
  hint?: string;
}

const REQUIRED_FATAL: EnvSpec[] = [
  { key: "WHATSAPP_TOKEN", fatal: true, hint: "Meta WhatsApp Cloud API access token" },
  { key: "WHATSAPP_PHONE_NUMBER_ID", fatal: true, hint: "Meta WhatsApp phone number id" },
  { key: "ADMIN_JWT_SECRET", fatal: true, hint: "Random 32+ char string for admin dashboard auth (generate: openssl rand -hex 32)" },
  { key: "DATABASE_URL", fatal: true, hint: "PostgreSQL connection string" },
];

const RECOMMENDED: EnvSpec[] = [
  { key: "REDIS_URL", fatal: false, hint: "Redis connection string for caching and rate limiting" },
  { key: "GROQ_API_KEY", fatal: false, hint: "Groq API key for AI features (optional — fallback responses used if missing)" },
  { key: "MONNIFY_API_KEY", fatal: false, hint: "Monnify payouts/virtual accounts (primary provider)" },
  { key: "MONNIFY_SECRET_KEY", fatal: false },
  { key: "MONNIFY_CONTRACT_CODE", fatal: false },
  { key: "PAYSTACK_SECRET_KEY", fatal: false, hint: "Paystack fallback provider" },
  { key: "FLUTTERWAVE_WEBHOOK_HASH", fatal: false, hint: "Flutterwave webhook signature secret" },
  { key: "SESSION_SECRET", fatal: false, hint: "random 32+ char string for signing" },
  { key: "TELEGRAM_BOT_TOKEN", fatal: false, hint: "Telegram bot token (optional — WhatsApp-only if missing)" },
];

export interface EnvReport {
  ok: boolean;
  problems: string[];
}

export function validateEnvironment(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const problems: string[] = [];

  for (const spec of [...REQUIRED_FATAL, ...RECOMMENDED]) {
    if (env[spec.key]?.trim()) continue;
    // In tests we don't demand provider keys at all.
    if (process.env.NODE_ENV === "test" && !spec.fatal) continue;
    if (spec.fatal) {
      problems.push(`❌ FATAL: ${spec.key} is not set — ${spec.hint ?? "required to run"}`);
    } else {
      problems.push(`⚠️  ${spec.key} is not set — ${spec.hint ?? "optional integration disabled"}`);
    }
  }

  // Weak-secret detector for anything that IS set — fail in production, warn otherwise.
  const isProd = env.NODE_ENV === "production";

  const sessionSecret = env.SESSION_SECRET ?? "";
  if (sessionSecret && sessionSecret.length < 32) {
    problems.push(`${isProd ? "❌ FATAL" : "⚠️ "}: SESSION_SECRET looks too short (<32 chars) — use a long random value.`);
  }
  if (sessionSecret && /^(test|secret|changeme|123456|password)/i.test(sessionSecret)) {
    problems.push(`${isProd ? "❌ FATAL" : "⚠️ "}: SESSION_SECRET looks like a placeholder — generate with \`openssl rand -hex 32\`.`);
  }

  // Check ADMIN_JWT_SECRET for weak values — FATAL in production
  const adminSecret = env.ADMIN_JWT_SECRET ?? "";
  if (adminSecret && /^(dev-admin-secret-change-me|test|secret|changeme|123456|password)/i.test(adminSecret)) {
    problems.push(`❌ FATAL: ADMIN_JWT_SECRET is a placeholder — generate with \`openssl rand -hex 32\`.`);
  }
  if (!adminSecret && isProd) {
    problems.push("❌ FATAL: ADMIN_JWT_SECRET is not set — required for production.");
  }

  const twoFaRequired = env.TWO_FA_REQUIRED === "1";
  const anyProvider =
    Boolean(env.MONNIFY_API_KEY) || Boolean(env.PAYSTACK_SECRET_KEY) || Boolean(process.env.FLUTTERWAVE_SECRET_KEY);
  if (!anyProvider && process.env.NODE_ENV !== "test") {
    problems.push("⚠️  No payment provider is configured — money IN/OUT will fail. Set MONNIFY_* first.");
  }
  if (twoFaRequired && process.env.NODE_ENV !== "production") {
    problems.push("ℹ️  TWO_FA_REQUIRED=1 outside production — fine for rehearsal.");
  }

  return { ok: !problems.some((p) => p.startsWith("❌")), problems };
}
