import { prisma } from "../lib/prisma.js";
import { generateTotpSecret, otpauthUri, verifyTotp } from "../lib/totp.js";
import { verifyMemberPin } from "./pin.js";

/**
 * Two-factor authentication for money-moving admin/super commands.
 *
 * - `enable2fa` enrols a member: stores a base32 TOTP secret, shows the
 *   otpauth:// URI to scan with Google Authenticator / Authy.
 * - Once enrolled, every MONEY-OUT command must end with a live 6-digit code,
 *   e.g. `finalize abc123 482915`. The code is stripped before the command's
 *   own argument parsing.
 * - `TWO_FA_REQUIRED=1` forces every admin/super to enrol (commands fail with
 *   instructions until they do). Disabled by default; always off in tests
 *   unless the member is actually enrolled.
 */

export interface MoneyGuardResult {
  ok: boolean;
  message?: string;
  /** Remaining args after a trailing TOTP code was consumed. */
  args: string[];
}

export async function enable2fa(
  phone: string,
): Promise<{ ok: boolean; message: string }> {
  const member = await prisma.member.findFirst({ where: { phone } });
  if (!member) return { ok: false, message: "You need to join a cooperative first." };
  if (!["admin", "superadmin"].includes(member.role)) {
    return { ok: false, message: "2FA is for admins and super admins." };
  }

  const secret = generateTotpSecret();
  await prisma.member.update({ where: { id: member.id }, data: { totpSecret: secret } });

  const uri = otpauthUri(secret, member.phone);
  return {
    ok: true,
    message:
      `🔐 *2FA enabled.* Scan this into your authenticator app (Google Authenticator, Authy, …):\n\n${uri}\n\n` +
      `Or manually add the key:\n\`${secret}\`\n\n` +
      `From now on, end every *money-out* command with the app's 6-digit code — e.g.\n*finalize abc123 482915*`,
  };
}

export async function disable2fa(phone: string): Promise<{ ok: boolean; message: string }> {
  const member = await prisma.member.findFirst({ where: { phone } });
  if (!member?.totpSecret) return { ok: false, message: "2FA isn't enabled on your account." };
  await prisma.member.update({ where: { id: member.id }, data: { totpSecret: null } });
  return { ok: true, message: "2FA disabled. Your commands no longer need an authenticator code." };
}

/**
 * Gate for money-out commands. Consumes a trailing 6-digit TOTP code when the
 * actor is enrolled; enforces enrolment when TWO_FA_REQUIRED=1.
 * Never enforced in test runs unless the member actually has a secret.
 */
export async function assertMoneyAuthorized(
  actorId: string,
  args: string[],
): Promise<MoneyGuardResult> {
  const member = await prisma.member.findUnique({ where: { id: actorId } });

  if (member?.totpSecret) {
    const last = args[args.length - 1] ?? "";
    const isCode = /^[0-9]{6}$/.test(last);
    // Only treat the last arg as a code when it isn't plausibly something else
    // (ids/amounts/phones are never exactly 6 digits in our flows).
    if (!isCode || !verifyTotp(member.totpSecret, last)) {
      return {
        ok: false,
        message:
          "🔐 This command moves money — append your authenticator's *6-digit code*, e.g. `finalize abc123 482915`.",
        args,
      };
    }
    return { ok: true, args: args.slice(0, -1) };
  }

  const required =
    process.env.TWO_FA_REQUIRED === "1" && process.env.NODE_ENV !== "test";
  if (required && member && ["admin", "superadmin"].includes(member.role)) {
    return {
      ok: false,
      message: "🔐 2FA is required for money-out commands. Reply *enable2fa* to set it up first.",
      args,
    };
  }

  return { ok: true, args };
}

// ---- Fresh-PIN threshold for large money-out ----
// A stolen unlocked phone shouldn't allow a single huge payout. Commands
// moving more than REPIN_THRESHOLD_NGN require the actor to have verified
// their own PIN within the last FRESH_PIN_MINUTES (reply `verifypin <code>`).

function repinThresholdNgn(): number {
  const raw = process.env.REPIN_THRESHOLD_NGN;
  if (raw !== undefined && raw !== "") return Math.max(0, Number(raw));
  return process.env.NODE_ENV === "test" ? 0 : 50_000;
}

const FRESH_PIN_MINUTES = 10;

export async function refreshPin(phone: string, pin: string): Promise<{ ok: boolean; message: string }> {
  const member = await prisma.member.findFirst({ where: { phone } });
  if (!member?.pin) return { ok: false, message: "You don't have a PIN set yet." };
  const result = await verifyMemberPin(member, pin);
  if (!result.ok) return { ok: false, message: result.message ?? "Wrong PIN." };

  const session = await prisma.session.upsert({
    where: { phone },
    create: { phone, state: "idle", data: JSON.stringify({ pinVerifiedAt: Date.now() }) },
    update: { data: JSON.stringify({ pinVerifiedAt: Date.now() }) },
  });
  void session;
  return { ok: true, message: `✅ PIN verified — large payouts are unlocked for the next ${FRESH_PIN_MINUTES} minutes.` };
}

/** True when amount is small enough (or feature off) that no fresh PIN is needed. */
export async function assertFreshPin(phone: string, amount: number): Promise<{ ok: boolean; message?: string }> {
  const threshold = repinThresholdNgn();
  if (threshold === 0 || !Number.isFinite(amount) || amount < threshold) return { ok: true };

  const session = await prisma.session.findUnique({ where: { phone } });
  const verifiedAt = (() => {
    try {
      return Number(JSON.parse(session?.data ?? "{}").pinVerifiedAt ?? 0);
    } catch {
      return 0;
    }
  })();
  if (Date.now() - verifiedAt < FRESH_PIN_MINUTES * 60 * 1000) return { ok: true };

  return {
    ok: false,
    message:
      `🔐 Payouts of *${threshold.toLocaleString()}+* need a fresh PIN. Reply *verifypin <your PIN>* first, then repeat this command.`,
  };
}
