import { randomInt } from "node:crypto";
import { prisma } from "./prisma.js";
import { hashOtp, verifyOtp } from "./security.js";
import { sendText } from "./messaging.js";

/**
 * Phone ownership proof for dashboard accounts.
 *
 * Members are verified by construction: their phone *is* their channel
 * identity. Dashboard admins and platform operators can change their channel
 * phone, so a magic link must not be trusted until the number on the account
 * has answered a code sent to it.
 *
 * Codes are scrypt-hashed, single use, 10-minute TTL, 5 attempts. Requesting a
 * new code invalidates the previous one.
 */

export const PHONE_OTP_TTL_MS = 10 * 60_000;
export const PHONE_OTP_MAX_ATTEMPTS = 5;

export type PhoneOtpSubject = "member" | "platform_admin";

function sixDigits(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function maskPhone(phone: string): string {
  if (phone.length <= 4) return "****";
  return `${"*".repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;
}

export interface RequestPhoneOtpInput {
  subjectType: PhoneOtpSubject;
  subjectId: string;
  phone: string;
}

/**
 * Mint and send a code. Returns `sent: false` when the channel refused the
 * message — the code is still stored so a retry of the same request can use it
 * if the message was merely delayed.
 */
export async function requestPhoneOtp(
  input: RequestPhoneOtpInput,
): Promise<{ sent: boolean; maskedPhone: string }> {
  const { subjectType, subjectId, phone } = input;

  await prisma.phoneOtp.updateMany({
    where: { subjectType, subjectId, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const code = sixDigits();
  await prisma.phoneOtp.create({
    data: {
      subjectType,
      subjectId,
      codeHash: hashOtp(code),
      expiresAt: new Date(Date.now() + PHONE_OTP_TTL_MS),
    },
  });

  const sent = await sendText({
    to: phone,
    text: `Your verification code is ${code}. It expires in 10 minutes and works once.`,
  }).catch(() => false);

  return { sent, maskedPhone: maskPhone(phone) };
}

/**
 * Check a code and, on success, mark the account's phone verified.
 *
 * Failure is deliberately indistinguishable between "no code", "wrong code"
 * and "too many attempts" so the caller cannot probe state.
 */
export async function verifyPhoneOtp(input: {
  subjectType: PhoneOtpSubject;
  subjectId: string;
  code: string;
}): Promise<boolean> {
  const code = input.code.trim();
  if (!/^\d{6}$/.test(code)) return false;

  const row = await prisma.phoneOtp.findFirst({
    where: {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!row || row.attempts >= PHONE_OTP_MAX_ATTEMPTS) return false;

  const ok = verifyOtp(code, row.codeHash);
  if (!ok) {
    await prisma.phoneOtp.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    });
    return false;
  }

  await prisma.phoneOtp.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
  if (input.subjectType === "member") {
    await prisma.member.update({ where: { id: input.subjectId }, data: { phoneVerified: true } });
  } else {
    await prisma.platformAdmin.update({
      where: { id: input.subjectId },
      data: { phoneVerified: true },
    });
  }
  return true;
}
