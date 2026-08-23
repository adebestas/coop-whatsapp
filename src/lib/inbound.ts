export interface InboundMessage {
  from: string;
  text: string;
  /** Present when the message is a completed WhatsApp Flow (nfm_reply). */
  flowToken?: string;
}

/**
 * Normalise one WhatsApp webhook `change.value` into inbound messages.
 *
 * Handles plain text plus interactive Flow completions (nfm_reply): the
 * user's input arrives in response_json — never as chat text — so masked
 * PIN entry never lands in the conversation history.
 */
export function extractWhatsAppMessages(changeValue: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const messages = (changeValue as { messages?: unknown[] })?.messages;
  if (!Array.isArray(messages)) return out;

  for (const raw of messages) {
    const message = raw as {
      from?: string;
      type?: string;
      text?: { body?: string };
      interactive?: {
        type?: string;
        nfm_reply?: { response_json?: string };
      };
    };
    const from = message.from;
    if (!from) continue;

    if (message.type === "text" && message.text?.body) {
      out.push({ from, text: message.text.body });
      continue;
    }

    if (
      message.type === "interactive" &&
      message.interactive?.type === "nfm_reply"
    ) {
      let fields: Record<string, unknown> = {};
      try {
        fields = JSON.parse(message.interactive.nfm_reply?.response_json ?? "{}");
      } catch {
        // Malformed payload — treat as empty and fall through to the guard below.
      }
      const text = typeof fields.code === "string" ? fields.code : "";
      if (!text) continue; // not a secure-input flow reply we can act on
      out.push({
        from,
        text,
        flowToken: typeof fields.flow_token === "string" ? fields.flow_token : undefined,
      });
    }
    // Anything else (reactions, images, buttons…) is intentionally dropped.
  }
  return out;
}
