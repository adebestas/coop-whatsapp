import { sendText as sendWhatsApp, sendFlowMessage } from "./whatsapp.js";
import { sendTelegramMessage } from "./telegram.js";
import { config } from "../config.js";

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

/**
 * Channel-aware prompt for secrets (PIN / OTP).
 *
 * - Telegram: plain text (the polling loop deletes the user's reply instead).
 * - WhatsApp: interactive Flow card with a masked passcode box when
 *   WHATSAPP_PIN_FLOW_ID is configured — the secret never renders in chat.
 *   Falls back to plain text if the card cannot be delivered.
 */
export async function sendSecurePrompt(params: {
  to: string;
  text: string;
  flowToken?: string;
}): Promise<boolean> {
  const { to, text, flowToken } = params;

  if (!to.startsWith("tg:") && config.whatsapp.pinFlowId && flowToken) {
    const sent = await sendFlowMessage({
      to,
      flowId: config.whatsapp.pinFlowId,
      flowToken,
      cta: "Enter securely",
      body: text,
    });
    if (sent) return true;
    // Flow card failed (unpublished flow id, API hiccup) — degrade gracefully.
  }
  return sendText({ to, text });
}

/** Which platform does this channel id belong to? */
export function platformOf(channelId: string): "whatsapp" | "telegram" {
  return channelId.startsWith("tg:") ? "telegram" : "whatsapp";
}

/**
 * Deliver a NOTIFICATION to a member via their most-used platform — never
 * both, so nobody's phone gets the same alert twice. Falls back to the
 * primary chat when no alternate is linked. Interactive conversation replies
 * keep using sendText on the session's own channel.
 */
export async function notifyMember(
  member: {
    phone: string;
    altChannelId?: string | null;
    preferredChannel?: string | null;
  },
  text: string,
): Promise<boolean> {
  const preferred = member.preferredChannel ?? platformOf(member.phone);
  if (preferred !== platformOf(member.phone) && member.altChannelId) {
    return sendText({ to: member.altChannelId, text });
  }
  return sendText({ to: member.phone, text });
}
