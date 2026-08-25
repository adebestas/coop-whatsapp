import { config } from "../config.js";

const API_BASE = "https://api.telegram.org";

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/**
 * Convert WhatsApp-style formatting to Telegram HTML.
 * WhatsApp: *bold*, _italic_, ~strikethrough~, ```code```
 * Telegram HTML: <b>, <i>, <s>, <code>
 */
function convertToTelegramHTML(text: string): string {
  // Escape HTML special characters BEFORE applying formatting tags.
  // Otherwise user-supplied <, >, & could inject HTML or break parsing.
  let result = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  result = result.replace(/\*([^*]+)\*/g, "<b>$1</b>");
  result = result.replace(/_([^_]+)_/g, "<i>$1</i>");
  result = result.replace(/~([^~]+)~/g, "<s>$1</s>");
  result = result.replace(/```([^`]+)```/g, "<code>$1</code>");
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");
  return result;
}

/**
 * Send a text message to a Telegram chat.
 * Converts WhatsApp-style formatting to HTML for proper rendering.
 */
export async function sendTelegramMessage(chatId: string | number, text: string): Promise<boolean> {
  if (!config.telegram.token) return false;
  const htmlText = convertToTelegramHTML(text);

  const res = await fetch(`${API_BASE}/bot${config.telegram.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: htmlText, parse_mode: "HTML" }),
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

/**
 * Delete a message from a private chat — bots may delete any message,
 * including ones sent by the user. Used to make typed PINs/OTPs vanish
 * from chat history right after they are read.
 */
export async function deleteTelegramMessage(chatId: string | number, messageId: number): Promise<boolean> {
  if (!config.telegram.token) return false;
  const res = await fetch(`${API_BASE}/bot${config.telegram.token}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[telegram] deleteMessage failed (${res.status}): ${body}`);
    return false;
  }
  return true;
}