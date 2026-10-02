import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyMember } from "../src/lib/messaging.js";
import { sendText } from "../src/lib/whatsapp.js";
import { sendTelegramMessage } from "../src/lib/telegram.js";

// tests/setup.ts wraps the real messaging.js in vi.fn() and mocks the transport.
// Assertions are made on the TRANSPORT spies: notifyMember calls the module-local
// sendText, which never passes through the exported wrapper.

const PHONE = "2348099990002";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("notifyMember consent gate", () => {
  it("does not send when the member opted out", async () => {
    const ok = await notifyMember({ phone: PHONE, optedOut: true }, "savings alert");
    expect(ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("sends to the primary phone when consent is unknown (optedOut null)", async () => {
    const ok = await notifyMember({ phone: PHONE, optedOut: null }, "savings alert");
    expect(ok).toBe(true);
    expect(sendText).toHaveBeenCalledWith(expect.objectContaining({ to: PHONE }));
  });

  it("honours the preferred alternate channel for consented members", async () => {
    const ok = await notifyMember(
      { phone: PHONE, altChannelId: "tg:999", preferredChannel: "telegram", optedOut: false },
      "loan update",
    );
    expect(ok).toBe(true);
    expect(sendTelegramMessage).toHaveBeenCalledWith("999", "loan update");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("opted-out members are skipped even when they have an alternate channel", async () => {
    const ok = await notifyMember(
      { phone: PHONE, altChannelId: "tg:999", preferredChannel: "telegram", optedOut: true },
      "loan update",
    );
    expect(ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });
});