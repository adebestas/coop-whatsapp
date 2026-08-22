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
  { key: "WHATSAPP_PHONE_ID", fatal: true, hint: "Meta WhatsApp phone number id" },
];

const RECOMMENDED: EnvSpec[] = [
  { key: "MONNIFY_API_KEY", fatal: false, hint: "Monnify payouts/virtual accounts (primary provider)" },
  { key: "MONNIFY_SECRET_KEY", fatal: false },
  { key: "MONNIFY_CONTRACT_CODE", fatal: false },
  { key: "PAYSTACK_SECRET_KEY", fatal: false, hint: "Paystack fallback provider" },
  { key: "FLUTTERWAVE_WEBHOOK_HASH", fatal: false, hint: "Flutterwave webhook signature secret" },
  { key: "SESSION_SECRET", fatal: false, hint: "random 32+ char string for signing" },
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

  // Weak-secret detector for anything that IS set.
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (sessionSecret && sessionSecret.length < 32) {
    problems.push("⚠️  SESSION_SECRET looks too short (<32 chars) — use a long random value.");
  }
  if (sessionSecret && /^(test|secret|changeme|123456|password)/i.test(sessionSecret)) {
    problems.push("⚠️  SESSION_SECRET looks like a placeholder — generate with `openssl rand -hex 32`.");
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
