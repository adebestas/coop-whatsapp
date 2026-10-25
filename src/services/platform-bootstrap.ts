import { randomInt } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { hashPin } from "../lib/security.js";
import { normalizePhone } from "../lib/phones.js";

/**
 * Seed the first platform owner from PLATFORM_OWNER_PHONE on boot.
 *
 * Idempotent and safe to call on every start:
 * - no-op when PLATFORM_OWNER_PHONE is unset/empty;
 * - no-op when an owner already exists (never logs the temp PIN twice);
 * - a unique-phone race (P2002) is treated as already-bootstrapped.
 *
 * The owner is created with a random 6-digit temp PIN and mustChangePin=true,
 * so the PIN can only be used to reach the change-pin flow. The plaintext PIN is
 * printed exactly once here — it is never persisted.
 */
export async function ensurePlatformOwner(): Promise<void> {
  const raw = process.env.PLATFORM_OWNER_PHONE?.trim();
  if (!raw) return;
  const phone = normalizePhone(raw);
  if (!phone) {
    console.error(
      `[platform-bootstrap] PLATFORM_OWNER_PHONE is not a valid phone number; owner not created.`,
    );
    return;
  }

  const existing = await prisma.platformAdmin.findFirst({ where: { role: "owner" } });
  if (existing) return;

  const tempPin = String(randomInt(100000, 1000000));
  try {
    await prisma.platformAdmin.create({
      data: {
        name: process.env.PLATFORM_OWNER_NAME?.trim() || "Platform Owner",
        phone,
        role: "owner",
        pin: hashPin(tempPin),
        mustChangePin: true,
        active: true,
      },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") return;
    throw err;
  }

  console.log(
    `[platform-bootstrap] Platform owner created for ${phone}. ` +
      `Temp PIN: ${tempPin} — change on first login at /dashboard/dev/ and enable 2FA immediately.`,
  );
}
