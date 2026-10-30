export interface InboundMessage {
  /** Channel message id (Meta wamid / Telegram message id) used for dedupe. */
  id?: string;
  from: string;
  text: string;
  /** Present when the message is a completed WhatsApp Flow (nfm_reply). */
  flowToken?: string;
  /** Present for voice-note audio messages (transcribed downstream). */
  audio?: { mediaId: string };
  /** Present for uploaded documents (e.g. an employer deduction schedule). */
  document?: { mediaId: string; filename?: string; mimeType?: string };
  /** Present for uploaded images (OCR'd downstream). */
  image?: { mediaId: string; mimeType?: string };
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
      id?: string;
      from?: string;
      type?: string;
      text?: { body?: string };
      interactive?: {
        type?: string;
        nfm_reply?: { response_json?: string };
      };
      audio?: { id?: string };
      document?: { id?: string; filename?: string; mime_type?: string };
      image?: { id?: string; mime_type?: string };
    };
    const from = message.from;
    if (!from) continue;
    const id = message.id;

    if (message.type === "text" && message.text?.body) {
      out.push({ id, from, text: message.text.body });
      continue;
    }

    if (message.type === "interactive" && message.interactive?.type === "nfm_reply") {
      let fields: Record<string, unknown> = {};
      try {
        fields = JSON.parse(message.interactive.nfm_reply?.response_json ?? "{}");
      } catch {
        // Malformed payload — treat as empty and fall through to the guard below.
      }
      const text = typeof fields.code === "string" ? fields.code : "";
      if (!text) continue; // not a secure-input flow reply we can act on
      out.push({
        id,
        from,
        text,
        flowToken: typeof fields.flow_token === "string" ? fields.flow_token : undefined,
      });
      continue;
    }

    // Interactive button clicks (e.g. [Check Balance], [Save], [Menu])
    if (message.type === "interactive") {
      const interactive = message.interactive as {
        type?: string;
        button_reply?: { id?: string; title?: string };
        list_reply?: { id?: string; title?: string };
      };
      if (interactive.type === "button_reply" && interactive.button_reply) {
        const text = interactive.button_reply.id || interactive.button_reply.title || "";
        if (text) {
          out.push({ id, from, text });
          continue;
        }
      }
      if (interactive.type === "list_reply" && interactive.list_reply) {
        const text = interactive.list_reply.id || interactive.list_reply.title || "";
        if (text) {
          out.push({ id, from, text });
          continue;
        }
      }
    }

    // Voice notes: carry the media id so the route can transcribe downstream.
    if (message.type === "audio" && message.audio?.id) {
      out.push({ id, from, text: "", audio: { mediaId: message.audio.id } });
      continue;
    }

    // Documents (e.g. an employer deduction schedule) and images (OCR).
    if (message.type === "document" && message.document?.id) {
      out.push({
        id,
        from,
        text: "",
        document: {
          mediaId: message.document.id,
          filename: message.document.filename,
          mimeType: message.document.mime_type,
        },
      });
      continue;
    }
    if (message.type === "image" && message.image?.id) {
      out.push({
        id,
        from,
        text: "",
        image: { mediaId: message.image.id, mimeType: message.image.mime_type },
      });
      continue;
    }
    // Anything else (reactions, buttons…) is intentionally dropped.
  }
  return out;
}
