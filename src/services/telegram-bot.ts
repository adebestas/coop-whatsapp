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
    // Member — account
    { command: "menu", description: "Show available commands" },
    { command: "help", description: "See the full command list" },
    { command: "join", description: "Join a cooperative (e.g. /join CODE)" },
    { command: "balance", description: "Check your wallet balance" },
    { command: "save", description: "Make a contribution (e.g. /save 5000)" },
    { command: "withdraw", description: "Request a withdrawal" },
    { command: "loan", description: "Apply for a loan (e.g. /loan 50000 3)" },
    { command: "repay", description: "Repay your loan installment" },
    { command: "plan", description: "Set a recurring plan (e.g. /plan 5000 weekly)" },
    { command: "fund", description: "Get your personal top-up account number" },
    { command: "history", description: "Your transaction statement" },
    { command: "statement", description: "Get a statement" },
    { command: "ledger", description: "Cooperative ledger (transparency)" },
    { command: "dividend", description: "Dividend calculator" },
    { command: "code", description: "See your member file number" },
    { command: "phone", description: "Add or update your real phone number" },
    { command: "byelaws", description: "View cooperative byelaws" },
    { command: "posts", description: "Community posts / announcements" },
    { command: "joinunit", description: "Join a workplace unit (/joinunit CODE)" },
    { command: "mydata", description: "View personal data (NDPR access)" },
    { command: "deleteaccount", description: "Delete your account" },
    { command: "optout", description: "Stop all messages" },
    { command: "optin", description: "Re-enable messages" },
    // Financial literacy
    { command: "class", description: "Start/resume financial literacy class" },
    { command: "next", description: "Next lesson" },
    { command: "contexthelp", description: "Personalized help" },
    { command: "insights", description: "AI financial analysis" },
    // Support & governance
    { command: "support", description: "Open a support ticket (e.g. /support issue)" },
    { command: "tickets", description: "See your support tickets" },
    { command: "grievance", description: "Submit a complaint to admin" },
    { command: "reserveinfo", description: "Reserve Fund dashboard" },
    // Elections & buy-votes (members)
    { command: "vote", description: "Vote in an election (/vote ID CODE)" },
    { command: "pollresults", description: "Live election results" },
    { command: "buypolls", description: "See what the coop is voting to buy" },
    { command: "votebuy", description: "Vote in a buy poll (/votebuy ID #)" },
    // Admin commands
    { command: "admin", description: "See admin commands" },
    { command: "members", description: "Admin: list all members" },
    { command: "broadcast", description: "Admin: send message to all members" },
    { command: "pending", description: "Admin: pending loans" },
    { command: "approve", description: "Admin: approve a loan" },
    { command: "reject", description: "Admin: reject a loan" },
    { command: "approvewdraw", description: "Admin: approve a withdrawal" },
    { command: "startvote", description: "Admin: start an election (/startvote exec President ...)" },
    { command: "candidate", description: "Admin: add election candidate (/candidate ID CODE)" },
    { command: "closevote", description: "Admin: close & tally an election" },
    { command: "startbuyvote", description: "Admin: start a buy poll (/startbuyvote title)" },
    { command: "addoption", description: "Admin: add buy-poll option" },
    { command: "closebuyvote", description: "Admin: close a buy poll" },
    { command: "agm", description: "AGM: schedule or info (/agm schedule YYYY-MM-DD)" },
    { command: "enable2fa", description: "Protect your account with 2FA" },
    { command: "verifypin", description: "Unlock big payouts (10 min)" },
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
 *
 * NOTE: Long polling is used here for development convenience. In production,
 * switch to webhooks for lower latency and better scalability:
 *   1. Set a webhook URL: POST /bot<TOKEN>/setWebhook?url=<YOUR_DOMAIN>/telegram/webhook
 *   2. Add an Express/Fastify route at /telegram/webhook that calls handleMessage()
 *   3. Remove this long-polling loop and the getTelegramUpdates import.
 *   4. Ensure the webhook endpoint validates Telegram's X-Telegram-Bot-Api-Secret-Token header.
 * See: https://core.telegram.org/bots/api#setwebhook
 */
/**
 * Start the Telegram bot using long-polling.
 *
 * NOTE: Long-polling does not scale horizontally — for production multi-instance
 * deployments, switch to webhook mode. See comments above for migration steps.
 */
export async function startTelegramBot(): Promise<void> {
  if (!config.telegram.token) {
    console.log("[telegram] no bot token configured — Telegram disabled");
    return;
  }

  console.log("[telegram] long-polling started");
  await setTelegramCommands();
  let consecutiveEmpty = 0;
  for (;;) {
    try {
      const updates = await getTelegramUpdates(offset);
      if (updates.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty > 3) {
          // Likely a 409 conflict — another instance is polling
          await sleep(10000);
          continue;
        }
        await sleep(1000);
        continue;
      }
      consecutiveEmpty = 0;
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
      await sleep(5000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}