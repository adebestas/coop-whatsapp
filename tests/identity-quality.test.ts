import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isDisposableEmail,
  rejectDisposableEmail,
  resetDisposableEmailCache,
} from "../src/lib/disposable-emails.js";
import { prisma, cleanupDatabase } from "./setup.js";
import { PHONE_OTP_MAX_ATTEMPTS, requestPhoneOtp, verifyPhoneOtp } from "../src/lib/phone-otp.js";
import { hashOtp } from "../src/lib/security.js";

beforeEach(async () => {
  await cleanupDatabase();
  await prisma.phoneOtp.deleteMany();
});
afterEach(() => {
  delete process.env.DISPOSABLE_EMAIL_DOMAINS;
  resetDisposableEmailCache();
});

describe("disposable email screening", () => {
  it("flags listed domains and their subdomains", () => {
    expect(isDisposableEmail("a@mailinator.com")).toBe(true);
    expect(isDisposableEmail("a@mail.MAILINATOR.com")).toBe(true);
    expect(isDisposableEmail("a@coop.example.ng")).toBe(false);
  });

  it("merges DISPOSABLE_EMAIL_DOMAINS at boot", () => {
    process.env.DISPOSABLE_EMAIL_DOMAINS = " @Burner.Example , extra.test ";
    resetDisposableEmailCache();
    expect(isDisposableEmail("x@burner.example")).toBe(true);
    expect(isDisposableEmail("x@sub.extra.test")).toBe(true);
  });

  it("returns a deliberately vague rejection", () => {
    expect(rejectDisposableEmail("a@yopmail.com")).toEqual({
      ok: false,
      message: "Please use a different email address.",
    });
    expect(rejectDisposableEmail("a@real.coop")).toEqual({ ok: true });
  });
});

describe("phone OTP", () => {
  async function seed(subjectId: string, code: string, attempts = 0) {
    return prisma.phoneOtp.create({
      data: {
        subjectType: "platform_admin",
        subjectId,
        codeHash: hashOtp(code),
        attempts,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
  }

  it("verifies once and sets phoneVerified", async () => {
    const admin = await prisma.platformAdmin.create({
      data: { name: "OTP", phone: "2348011100011", pin: hashOtp("123456") },
    });
    await seed(admin.id, "123456");

    await expect(
      verifyPhoneOtp({ subjectType: "platform_admin", subjectId: admin.id, code: "123456" }),
    ).resolves.toBe(true);
    await expect(
      verifyPhoneOtp({ subjectType: "platform_admin", subjectId: admin.id, code: "123456" }),
    ).resolves.toBe(false);
    expect(
      (await prisma.platformAdmin.findUnique({ where: { id: admin.id } }))?.phoneVerified,
    ).toBe(true);
  });

  it("refuses once attempts are exhausted", async () => {
    const admin = await prisma.platformAdmin.create({
      data: { name: "OTP2", phone: "2348011100022", pin: hashOtp("123456") },
    });
    await seed(admin.id, "222222", PHONE_OTP_MAX_ATTEMPTS);

    await expect(
      verifyPhoneOtp({ subjectType: "platform_admin", subjectId: admin.id, code: "222222" }),
    ).resolves.toBe(false);
  });

  it("issues a fresh row per request and drops the old one", async () => {
    const result = await requestPhoneOtp({
      subjectType: "platform_admin",
      subjectId: "no-such-admin",
      phone: "2348011100033",
    });
    expect(result.maskedPhone).toBe("*********0033");
    const rows = await prisma.phoneOtp.findMany({ where: { subjectId: "no-such-admin" } });
    expect(rows.length).toBe(1);
    expect(rows[0].codeHash).not.toMatch(/^\d{6}$/);
  });
});
