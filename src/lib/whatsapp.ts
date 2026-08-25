import { config } from "../config.js";

const API_BASE = "https://graph.facebook.com/v21.0";

export interface SendTextParams {
  to: string;
  text: string;
}

export async function sendText({ to, text }: SendTextParams): Promise<boolean> {
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

/**
 * Send a pre-approved WhatsApp template message.
 * Templates must be registered and approved by Meta before use.
 *
 * Registered templates (commented for Meta approval):
 *   - coop_notification: balance alerts, dividend announcements
 *   - coop_otp: verification codes
 *   - coop_statement: monthly statements
 */
export async function sendTemplate(
  to: string,
  templateName: string,
  langCode: string,
  params?: string[],
): Promise<boolean> {
  const url = `${API_BASE}/${config.whatsapp.phoneNumberId}/messages`;
  const components: Record<string, unknown>[] = [];

  if (params && params.length > 0) {
    components.push({
      type: "body",
      parameters: params.map((p) => ({ type: "text", text: p })),
    });
  }

  const payload: Record<string, unknown> = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: langCode },
    },
  };

  if (components.length > 0) {
    (payload.template as Record<string, unknown>).components = components;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.whatsapp.token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[whatsapp] template send failed (${res.status}): ${body}`);
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
export async function sendFlowMessage({ to, flowId, flowToken, cta, body }: SendFlowParams): Promise<boolean> {
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