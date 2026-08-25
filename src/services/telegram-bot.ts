import { config } from "../config.js";
import { getTelegramUpdates, sendTelegramMessage } from "../lib/telegram.js";
import { handleMessage } from "./conversation.js";

const API_BASE = "https://api.telegram.org";

let offset = 0;

/**
 * Register the bot's command list with Telegram so users see
 * autocomplete suggestions in the chat input.
 */
async function setTelegramCommands(): Promise<void> {
  if (!config.telegram.token) return;
  const commands = [
    { command: "menu", description: "Show available commands" },
    { command: "balance", description: "Check your wallet balance" },
    { command: "save", description: "Make a contribution (e.g. /save 5000)" },
    { command: "withdraw", description: "Request a withdrawal" },
    { command: "loan", description: "Apply for a loan" },
    { command: "repay", description: "Repay your loan" },
    { command: "history", description: "View transaction history" },
    { command: "help", description: "Get help" },
  ];
  try {
    const res = await fetch(`${API_BASE}/bot${config.telegram.token}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
    });
    if (!res.ok) {
      console.error("[telegram] setMyCommands failed:", await res.text());
    }
  } catch (err) {
    console.error("[telegram] setMyCommands error:", err);
  }
}

/**
 * Runs a long-polling loop that feeds Telegram messages into the same
 * conversation handler used for WhatsApp. Telegram user ids are prefixed
 * with "tg:" so the channel dispatcher knows where to reply.
 */
export async function startTelegramBot(): Promise<void> {
  if (!config.telegram.token) {
    console.log("[telegram] no bot token configured — Telegram disabled");
    return;
  }

  console.log("[telegram] long-polling started");
  await setTelegramCommands();
  for (;;) {
    try {
      const updates = await getTelegramUpdates(offset);
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        const message = update.message;
        if (!message?.text) continue;

        // Only handle private chats — ignore group/supergroup/channel messages
        if (message.chat.type !== "private") {
          await sendTelegramMessage(
            message.chat.id,
            "I only work in private chats. Please message me directly.",
          );
          continue;
        }

        const chatId = message.chat.id;
        const userId = `tg:${chatId}`;
        const text = message.text.trim();

        void handleMessage(userId, text, { telegramMessageId: message.message_id }).catch((err) => {
          console.error(`[telegram] handleMessage failed for ${userId}`, err);
        });
      }
    } catch (err) {
      console.error("[telegram] polling error:", err);
      await sleep(3000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}