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