import { config } from "../config.js";
import { getTelegramUpdates, sendTelegramMessage } from "../lib/telegram.js";
import { handleMessage } from "./conversation.js";

let offset = 0;

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