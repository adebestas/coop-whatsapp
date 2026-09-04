import { config } from "../config.js";

const API_BASE = "https://api.telegram.org";

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
}

/** An inline keyboard button (callback-driven). */
export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
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
  const url = `${API_BASE}/bot${config.telegram.token}/getUpdates?offset=${offset}&timeout=${timeout}&allowed_updates=%5B%22message%22,%22callback_query%22%5D`;
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

/**
 * Send a message with an inline reply-markup keyboard and return the new
 * message id (used to track a live PIN-entry card). Returns null on failure.
 */
export async function sendTelegramKeyboard(
  chatId: string | number,
  text: string | string[],
  buttons: TelegramInlineButton[][],
): Promise<number | null> {
  if (!config.telegram.token) return null;
  const html = convertToTelegramHTML(Array.isArray(text) ? text.join(" ") : text);
  const res = await fetch(`${API_BASE}/bot${config.telegram.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[telegram] sendKeyboard failed (${res.status}): ${body}`);
    return null;
  }
  const json = (await res.json()) as { ok: boolean; result: { message_id: number } };
  return json.ok ? json.result.message_id : null;
}

/**
 * Edit an existing message's text and/or inline keyboard. Passing null buttons
 * removes the keyboard. Used to update PIN progress dots and tear the card down.
 */
export async function editTelegramMessage(
  chatId: string | number,
  messageId: number,
  text: string,
  buttons: TelegramInlineButton[][] | null,
): Promise<boolean> {
  if (!config.telegram.token) return false;
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text: convertToTelegramHTML(text),
    parse_mode: "HTML",
  };
  if (buttons === null) payload.reply_markup = { inline_keyboard: [] };
  else if (buttons.length > 0) payload.reply_markup = { inline_keyboard: buttons };
  const res = await fetch(`${API_BASE}/bot${config.telegram.token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[telegram] editMessage failed (${res.status}): ${body}`);
    return false;
  }
  return true;
}

/** Acknowledge a callback query so Telegram stops showing a loading spinner. */
export async function answerTelegramCallback(callbackId: string): Promise<void> {
  if (!config.telegram.token) return;
  try {
    await fetch(`${API_BASE}/bot${config.telegram.token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId }),
    });
  } catch {
    /* best-effort */
  }
}

/** Build the numeric PIN keyboard rows with callback payloads "pin:0..9", "pin:del", "pin:ok". */
export function buildPinKeyboard(): TelegramInlineButton[][] {
  const row = (vals: string[]) => vals.map((v) => ({ text: v, callback_data: `pin:${v}` }));
  return [
    row(["1", "2", "3"]),
    row(["4", "5", "6"]),
    row(["7", "8", "9"]),
    [
      { text: "⌫", callback_data: "pin:del" },
      { text: "0", callback_data: "pin:0" },
      { text: "✓ Done", callback_data: "pin:ok" },
    ],
  ];
}