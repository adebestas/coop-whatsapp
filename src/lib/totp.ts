import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Minimal RFC 6238 TOTP (30s steps, SHA-1, 6 digits) — the same algorithm as
 * Google Authenticator / Authy. Implemented directly so we carry no extra
 * dependency for a security-critical primitive.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP digest for a counter (RFC 4226). */
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac("sha1", secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

/** Current TOTP for a base32 secret at a given time (ms). */
export function totpAt(secretBase32: string, timeMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(timeMs / 30_000));
}

/**
 * Verify a code with a ±1 step clock-skew window, constant-time compare.
 */
export function verifyTotp(secretBase32: string, code: string, timeMs = Date.now()): boolean {
  const cleaned = code.replace(/[^0-9]/g, "");
  if (cleaned.length !== 6) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(timeMs / 30_000);
  for (const drift of [-1, 0]) { // 60-second window instead of 90
    const expected = hotp(secret, counter + drift);
    const a = Buffer.from(expected);
    const b = Buffer.from(cleaned);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** otpauth:// URI for authenticator apps. */
export function otpauthUri(secretBase32: string, accountLabel: string, issuer = "Coop"): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer });
  return `otpauth://totp/${label}?${params.toString()}`;
}
