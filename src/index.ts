import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startTelegramBot } from "./services/telegram-bot.js";
import { runAutoSaveReminders, runMonthlyInterest, runMonthlyStatements, runBirthdayGreetings } from "./services/scheduler.js";

const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

async function main() {
  const app = buildApp();

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Coop bot running on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Telegram runs independently via long-polling — no webhook needed.
  void startTelegramBot();

  // Background jobs: reminders, monthly interest, statements + birthday greetings.
  setInterval(() => {
    runAutoSaveReminders().catch((err) => app.log.error("[scheduler] auto-save reminders failed", err));
    runMonthlyInterest().catch((err) => app.log.error("[scheduler] interest accrual failed", err));
    runMonthlyStatements().catch((err) => app.log.error("[scheduler] monthly statements failed", err));
    runBirthdayGreetings().catch((err) => app.log.error("[scheduler] birthday greetings failed", err));
  }, SCHEDULER_INTERVAL_MS);
}

void main();