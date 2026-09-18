import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

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

const OTP_KEY_LEN = 32;

/** Hash an OTP with scrypt + random salt (slow hash, resists brute-force on 6-digit space). */
export function hashOtp(otp: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(otp, salt, OTP_KEY_LEN).toString("hex");
  return `${salt}:${hash}`;
}

/** Verify a plaintext OTP against a salted scrypt hash. */
export function verifyOtp(otp: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(otp, salt, OTP_KEY_LEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function generateGuarantorCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[randomInt(chars.length)]; // ✅ Cryptographically secure
  return `GT-${s}`;
}

/** Generate a short human-friendly member code (e.g. A1B2C3) for testing/guarantor refs. */
export function generateMemberCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[randomInt(chars.length)];
  return s;
}

/** PIN reset token: 6-digit code, expires in 15 minutes, single-use. */
export const PIN_RESET_CODE_LEN = 6;
export const PIN_RESET_TTL_MS = 15 * 60 * 1000; // 15 minutes

export function generatePinResetCode(): string {
  let code = "";
  for (let i = 0; i < PIN_RESET_CODE_LEN; i++) code += randomInt(10).toString();
  return code;
}

/** Hash a PIN reset code with short expiry. */
export function hashPinResetCode(code: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(code, salt, OTP_KEY_LEN).toString("hex");
  return `${salt}:${hash}:${Date.now() + PIN_RESET_TTL_MS}`;
}

/** Verify a PIN reset code against its hash (checks expiry + single-use via deletion). */
export function verifyPinResetCode(code: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  const [salt, hash, expiryStr] = parts;
  const expiry = parseInt(expiryStr, 10);
  if (isNaN(expiry) || Date.now() > expiry) return false; // Expired
  const candidate = scryptSync(code, salt, OTP_KEY_LEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}