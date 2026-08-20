/**
 * Normalize a phone number to E.164 (Nigeria: 234XXXXXXXXXX).
 * Accepts "+2348012345678", "2348012345678", "08012345678", "8012345678".
 * Returns null if it doesn't look like a valid mobile number.
 */
export function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("0")) digits = "234" + digits.slice(1);
  if (!/^234\d{10}$/.test(digits)) return null;
  return digits;
}