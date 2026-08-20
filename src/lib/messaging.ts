import { sendText as sendWhatsApp } from "./whatsapp.js";
import { sendTelegramMessage } from "./telegram.js";

/**
 * Channel-aware message sender.
 *
 * User identifiers are channel-scoped:
 *   - WhatsApp: raw E.164 phone, e.g. "2348012345678"
 *   - Telegram: "tg:<chatId>", e.g. "tg:123456789"
 *
 * All bot services call sendText() and never need to know the channel.
 */
export async function sendText(params: { to: string; text: string }): Promise<boolean> {
  const { to, text } = params;
  if (to.startsWith("tg:")) {
    return sendTelegramMessage(to.slice(3), text);
  }
  return sendWhatsApp({ to, text });
}