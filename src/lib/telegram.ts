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

/** Telegram's maximum message length in characters. */
const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Split a long message into chunks that fit within Telegram's 4096-char limit.
 * Tries to split on newlines first, then falls back to hard truncation.
 */
function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find the last newline within the limit
    let splitAt = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (splitAt <= 0) {
      // No good newline — hard truncate at limit
      splitAt = TELEGRAM_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }

  return chunks;
}

/**
 * Send a text message to a Telegram chat.
 * Converts WhatsApp-style formatting to HTML for proper rendering.
 * Automatically splits messages exceeding Telegram's 4096-char limit.
 */
export async function sendTelegramMessage(chatId: string | number, text: string): Promise<boolean> {
  if (!config.telegram.token) return false;

  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const htmlText = convertToTelegramHTML(chunk);
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