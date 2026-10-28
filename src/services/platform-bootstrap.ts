import { randomInt } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
 * written once to a 0600 file (never to stdout/logs) — logs are shipped, mirrored
 * and often over-readable, which is not acceptable for a platform-owner secret.
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

  const pinFile = resolve(process.env.PLATFORM_OWNER_PIN_FILE || "platform-owner-pin.txt");
  try {
    writeFileSync(pinFile, `${tempPin}\n`, { mode: 0o600 });
  } catch (err) {
    console.error(
      `[platform-bootstrap] Platform owner created for ${phone}, but the temp PIN could not be written to ${pinFile}: ` +
        `${err instanceof Error ? err.message : String(err)}. Reset it from the platform console.`,
    );
    return;
  }

  console.log(
    `[platform-bootstrap] Platform owner created for ${phone}. ` +
      `Temp PIN written to ${pinFile} (0600) — read it, change it on first login at /dashboard/dev/, enable 2FA, then delete the file.`,
  );
}
