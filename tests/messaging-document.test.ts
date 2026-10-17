import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendDocument } from "../src/lib/messaging.js";
import { sendDocument as sendWhatsAppDocument } from "../src/lib/whatsapp.js";
import { sendTelegramDocument } from "../src/lib/telegram.js";

const PHONE = "2348099990002";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendDocument channel routing", () => {
  it("routes WhatsApp documents to the WhatsApp transport", async () => {
    const ok = await sendDocument({
      to: PHONE,
      filename: "certificate.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.4 fake"),
      caption: "Your certificate",
    });
    expect(ok).toBe(true);
    expect(sendWhatsAppDocument).toHaveBeenCalledWith(
      expect.objectContaining({ to: PHONE, filename: "certificate.pdf" }),
    );
    expect(sendTelegramDocument).not.toHaveBeenCalled();
  });

  it("routes Telegram documents to the Telegram transport", async () => {
    const ok = await sendDocument({
      to: "tg:999",
      filename: "certificate.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.4 fake"),
      caption: "Your certificate",
    });
    expect(ok).toBe(true);
    expect(sendTelegramDocument).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "999", filename: "certificate.pdf" }),
    );
    expect(sendWhatsAppDocument).not.toHaveBeenCalled();
  });

  it("returns false when the transport fails", async () => {
    vi.mocked(sendWhatsAppDocument).mockResolvedValueOnce(false);
    const ok = await sendDocument({
      to: PHONE,
      filename: "certificate.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.4 fake"),
    });
    expect(ok).toBe(false);
  });
});