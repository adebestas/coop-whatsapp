import { verifyPin } from "../lib/security.js";
import { checkRateLimit, resetRateLimit } from "../lib/cache.js";

export const PIN_MAX_ATTEMPTS = 3;
export const PIN_LOCK_SECONDS = 15 * 60; // 15 minutes

export interface PinResult {
  ok: boolean;
  message?: string;
}

/**
 * Verify a member's transaction PIN with brute-force lockout.
 * Uses Redis atomic INCR + EXPIRE for lockout tracking — safe against
 * concurrent race conditions that the old read-then-write pattern allowed.
 */
export async function verifyMemberPin(
  member: { id: string; pin: string | null },
  pin: string,
): Promise<PinResult> {
  if (!member.pin) return { ok: false, message: "You have no PIN set yet." };

  // Check lockout FIRST — even correct PINs must wait out the lock window.
  const { allowed, retryAfter } = await checkRateLimit(
    `pin:${member.id}`,
    PIN_MAX_ATTEMPTS - 1, // blocks on the PIN_MAX_ATTEMPTS-th wrong attempt
    PIN_LOCK_SECONDS,
  );

  if (!allowed) {
    const mins = Math.ceil((retryAfter ?? PIN_LOCK_SECONDS) / 60);
    return {
      ok: false,
      message: `Too many wrong PINs. Your PIN is locked for *${mins} min*.`,
    };
  }

  if (verifyPin(pin, member.pin)) {
    await resetRateLimit(`pin:${member.id}`);
    return { ok: true };
  }

  return {
    ok: false,
    message: `Incorrect PIN. Try again or it will lock after ${PIN_MAX_ATTEMPTS} wrong attempts.`,
  };
}
