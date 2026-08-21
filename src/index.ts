import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startTelegramBot } from "./services/telegram-bot.js";
import { runAutoSaveReminders, runMonthlyStatements, runBirthdayGreetings } from "./services/scheduler.js";
import { scanGuarantorDefaults, executeDueDeductions } from "./services/guarantordeduction.js";
import { runBackup } from "./services/backup.js";
import { runReconciliation } from "./services/reconcile.js";

const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

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

  // Background jobs: reminders, monthly statements + birthday greetings,
  // guarantor default notices/deductions.
  setInterval(() => {
    runAutoSaveReminders().catch((err) => app.log.error("[scheduler] auto-save reminders failed", err));
    runMonthlyStatements().catch((err) => app.log.error("[scheduler] monthly statements failed", err));
    runBirthdayGreetings().catch((err) => app.log.error("[scheduler] birthday greetings failed", err));
    scanGuarantorDefaults()
      .then(async (n) => {
        if (n > 0) await executeDueDeductions().catch(() => {});
      })
      .catch((err) => app.log.error("[scheduler] guarantor default scan failed", err));
  }, SCHEDULER_INTERVAL_MS);

  // Data-loss protection: full backup every day, plus one at startup.
  void runBackup();
  setInterval(() => {
    runBackup().catch((err) => app.log.error("[backup] failed", err));
  }, BACKUP_INTERVAL_MS);

  // Nightly reconciliation + anomaly alerts to super admins.
  setInterval(() => {
    runReconciliation().catch((err) => app.log.error("[reconcile] failed", err));
  }, BACKUP_INTERVAL_MS);
}

void main();