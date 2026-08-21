import { prisma } from "../lib/prisma.js";
import { verifyPin } from "../lib/security.js";

export const PIN_MAX_ATTEMPTS = 3;
export const PIN_LOCK_MINUTES = 15;

export interface PinResult {
  ok: boolean;
  message?: string;
}

/**
 * Verify a member's transaction PIN with brute-force lockout:
 * 5 wrong attempts locks the PIN for 15 minutes.
 */
export async function verifyMemberPin(
  member: { id: string; pin: string | null },
  pin: string,
): Promise<PinResult> {
  if (!member.pin) return { ok: false, message: "You have no PIN set yet." };

  // Always work from fresh state so concurrent attempts can't slip through.
  const current = await prisma.member.findUnique({
    where: { id: member.id },
    select: { pinFailedCount: true, pinLockedUntil: true },
  });
  const failedCount = current?.pinFailedCount ?? 0;
  const lockedUntil = current?.pinLockedUntil ?? null;

  if (lockedUntil && lockedUntil.getTime() > Date.now()) {
    const mins = Math.ceil((lockedUntil.getTime() - Date.now()) / 60000);
    return { ok: false, message: `PIN locked after too many wrong attempts. Try again in *${mins} min*.` };
  }

  if (verifyPin(pin, member.pin)) {
    await prisma.member.update({
      where: { id: member.id },
      data: { pinFailedCount: 0, pinLockedUntil: null },
    });
    return { ok: true };
  }

  const failed = failedCount + 1;
  const lock = failed >= PIN_MAX_ATTEMPTS;
  await prisma.member.update({
    where: { id: member.id },
    data: {
      pinFailedCount: lock ? 0 : failed,
      pinLockedUntil: lock ? new Date(Date.now() + PIN_LOCK_MINUTES * 60 * 1000) : null,
    },
  });
  return {
    ok: false,
    message: lock
      ? `Too many wrong PINs. Your PIN is locked for *${PIN_LOCK_MINUTES} minutes*.`
      : `Incorrect PIN. ${PIN_MAX_ATTEMPTS - failed} attempt(s) left.`,
  };
}
