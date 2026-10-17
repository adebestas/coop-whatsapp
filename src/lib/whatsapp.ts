import { config } from "../config.js";

const API_BASE = "https://graph.facebook.com/v21.0";

export interface SendTextParams {
  to: string;
  text: string;
}

export interface SendDocumentParams {
  to: string;
  filename: string;
  mimeType: string;
  data: Buffer;
  caption?: string;
}

/**
 * Send a document (e.g. a PDF certificate) via the WhatsApp Cloud API.
 * The document is uploaded as a base64 media message.
 */
export async function sendDocument({
  to,
  filename,
  mimeType,
  data,
  caption,
}: SendDocumentParams): Promise<boolean> {
  const url = `${API_BASE}/${config.whatsapp.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.whatsapp.token}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "document",
      document: {
        filename,
        mime_type: mimeType,
        caption: caption ?? "",
        data: data.toString("base64"),
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[whatsapp] document send failed (${res.status}): ${body}`);
    return false;
  }
  return true;
}

export async function sendText({ to, text }: SendTextParams): Promise<boolean> {
  if (text.length > 4096) {
    text = text.substring(0, 4093) + "...";
  }
  const url = `${API_BASE}/${config.whatsapp.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.whatsapp.token}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[whatsapp] send failed (${res.status}): ${body}`);
    return false;
  }
  return true;
}

export interface SendFlowParams {
  to: string;
  flowId: string;
  /** One-time token we generate; echoed back in the webhook response_json. */
  flowToken: string;
  cta: string;
  body: string;
}

/**
 * Send an interactive Flow card (e.g. the masked PIN entry form).
 * The user's input arrives later as a "nfm_reply" webhook, NOT as chat text,
 * so it never shows up in the conversation history.
 */
export async function sendFlowMessage({
  to,
  flowId,
  flowToken,
  cta,
  body,
}: SendFlowParams): Promise<boolean> {
  const url = `${API_BASE}/${config.whatsapp.phoneNumberId}/messages`;
  const parameters: Record<string, unknown> = {
    flow_message_version: "3",
    flow_token: flowToken,
    flow_id: flowId,
    flow_cta: cta,
    flow_action: "navigate",
    flow_action_payload: { screen: "SECURE_INPUT" },
  };
  if (config.whatsapp.pinFlowMode === "draft") {
    // Unpublished flows can only be sent in draft mode (testing).
    parameters.mode = "draft";
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.whatsapp.token}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "flow",
        body: { text: body },
        action: { name: "flow", parameters },
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[whatsapp] flow send failed (${res.status}): ${errBody}`);
    return false;
  }
  return true;
}
