import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../tests/setup.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";
import { hashOtp } from "../src/lib/security.js";

const PHONE = "2348097000001";

async function startAwaitingOtp() {
  await prisma.session.deleteMany({ where: { phone: PHONE } });
  await prisma.session.create({
    data: {
      phone: PHONE,
      state: "awaiting_otp",
      data: JSON.stringify({
        name: "Test Member",
        contactPhone: PHONE,
        otp: hashOtp("123456"),
        otpExpiresAt: Date.now() + 10 * 60 * 1000,
      }),
    },
  });
}

function lastText(): string {
  const calls = vi.mocked(sendText).mock.calls;
  return String(calls[calls.length - 1]?.[0]?.text ?? "");
}

describe("member OTP verification lockout", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await startAwaitingOtp();
  });

  it("locks OTP entry after five wrong codes", async () => {
    for (let i = 0; i < 5; i++) await handleMessage(PHONE, "000000");
    expect(lastText()).toMatch(/locked/i);

    const session = await prisma.session.findUnique({ where: { phone: PHONE } });
    expect(session?.state).toBe("awaiting_otp");
  });

  it("refuses even the correct code while locked out", async () => {
    for (let i = 0; i < 5; i++) await handleMessage(PHONE, "000000");
    vi.clearAllMocks();

    await handleMessage(PHONE, "123456");

    expect(lastText()).toMatch(/locked/i);
    const session = await prisma.session.findUnique({ where: { phone: PHONE } });
    expect(session?.state).toBe("awaiting_otp");
  });
});
