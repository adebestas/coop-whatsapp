import { sendText as sendWhatsApp, sendFlowMessage, sendTemplate as sendWhatsAppTemplate } from "./whatsapp.js";
import { sendTelegramMessage } from "./telegram.js";
import { config } from "../config.js";
import { prisma } from "./prisma.js";

const WHATSAPP_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

  // WhatsApp 24-hour session window check
  if (!to.startsWith("tg:")) {
    const session = await prisma.session.findUnique({ where: { phone: to } });
    if (session?.lastInboundAt) {
      const elapsed = Date.now() - session.lastInboundAt.getTime();
      if (elapsed > WHATSAPP_SESSION_WINDOW_MS) {
        await sendWhatsApp({ to, text: "Hi! To receive messages from your cooperative, please send any message to re-activate." });
        return false;
      }
    }
  }

  if (to.startsWith("tg:")) {
    return sendTelegramMessage(to.slice(3), text);
  }
  await sleep(1500);
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
    // NOTE: Degrades to plaintext PIN prompt when the secure card isn't available.
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

/**
 * Channel-aware template sender (WhatsApp only).
 * Telegram does not support template messages; falls back to plain text.
 */
export async function sendTemplate(
  to: string,
  templateName: string,
  langCode: string,
  params?: string[],
): Promise<boolean> {
  if (to.startsWith("tg:")) return false;
  return sendWhatsAppTemplate(to, templateName, langCode, params);
}

export async function sendLongText(params: { to: string; text: string }): Promise<boolean> {
  const MAX_LEN = 3500;
  if (params.text.length <= MAX_LEN) return sendText(params);
  const parts = params.text.split('\n\n');
  let current = '';
  for (const part of parts) {
    if ((current + '\n\n' + part).length > MAX_LEN) {
      await sendText({ to: params.to, text: current.trim() });
      current = part;
    } else {
      current += (current ? '\n\n' : '') + part;
    }
  }
  if (current.trim()) await sendText({ to: params.to, text: current.trim() });
  return true;
}
