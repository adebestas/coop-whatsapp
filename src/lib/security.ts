import { randomBytes, randomInt, scryptSync, timingSafeEqual, createHash } from "node:crypto";

const KEY_LEN = 64;

export function hashPin(pin: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, KEY_LEN).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(pin, salt, KEY_LEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

/** Hash an OTP with a random salt for safe storage in session JSON. */
export function hashOtp(otp: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(`${salt}:${otp}`).digest("hex");
  return `${salt}:${hash}`;
}

/** Verify a plaintext OTP against a salted hash. */
export function verifyOtp(otp: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = createHash("sha256").update(`${salt}:${otp}`).digest("hex");
  return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(hash, "hex"));
}

export function generateMemberCode(): string {
  // Human-friendly, unambiguous: no 0/O/1/I.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const parts = [6, 4].map((len) => {
    let s = "";
    for (let i = 0; i < len; i++) s += chars[randomInt(chars.length)]; // ✅ Cryptographically secure
    return s;
  });
  return parts.join("-");
}

export function generateGuarantorCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[randomInt(chars.length)]; // ✅ Cryptographically secure
  return `GT-${s}`;
}