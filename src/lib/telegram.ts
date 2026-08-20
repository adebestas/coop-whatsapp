import { config } from "../config.js";

const API_BASE = "https://api.telegram.org";

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/**
 * Send a text message to a Telegram chat.
 * Strips WhatsApp-style *bold* markers since Telegram renders them literally.
 */
export async function sendTelegramMessage(chatId: string | number, text: string): Promise<boolean> {
  if (!config.telegram.token) return false;
  // Telegram doesn't understand *bold*; drop the asterisks for a clean read.
  const clean = text.replace(/\*/g, "");

  const res = await fetch(`${API_BASE}/bot${config.telegram.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: clean }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[telegram] send failed (${res.status}): ${body}`);
    return false;
  }
  return true;
}

/** Long-poll for new updates. Blocks up to `timeout` seconds on the server. */
export async function getTelegramUpdates(offset: number, timeout = 30): Promise<TelegramUpdate[]> {
  if (!config.telegram.token) return [];
  const url = `${API_BASE}/bot${config.telegram.token}/getUpdates?offset=${offset}&timeout=${timeout}&allowed_updates=%5B%22message%22%5D`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    console.error(`[telegram] getUpdates failed (${res.status}): ${body}`);
    return [];
  }
  const json = (await res.json()) as { ok: boolean; result: TelegramUpdate[] };
  return json.ok ? json.result : [];
}