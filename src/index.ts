import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startTelegramBot } from "./services/telegram-bot.js";
import {
  runAutoSaveReminders,
  runDailyDigest,
  runMonthlyStatements,
  runBirthdayGreetings,
} from "./services/scheduler.js";
import { scanGuarantorDefaults, executeDueDeductions } from "./services/guarantordeduction.js";
import { runBackup } from "./services/backup.js";
import { runReconciliation } from "./services/reconcile.js";
import { runTransferPolling, transferPollIntervalMs } from "./services/statuspoller.js";
import { validateEnvironment } from "./lib/envcheck.js";
import { prisma } from "./lib/prisma.js";
import { closeQueues } from "./lib/queue.js";
import { closeRedis } from "./lib/cache.js";

const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

// ===== Graceful Shutdown =====
let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[shutdown] ${signal} received, starting graceful shutdown...`);

  try {
    // 1. Stop accepting new connections
    await app.close();
    console.log("[shutdown] HTTP server closed");

    // 2. Close queue workers
    await closeQueues();
    console.log("[shutdown] Queue workers closed");

    // 3. Disconnect Redis
    await closeRedis();
    console.log("[shutdown] Redis disconnected");

    // 4. Disconnect database
    await prisma.$disconnect();
    console.log("[shutdown] Database disconnected");

    console.log("[shutdown] Graceful shutdown complete");
    process.exit(0);
  } catch (err) {
    console.error("[shutdown] Error during shutdown:", err);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

let app: ReturnType<typeof buildApp>;

async function main() {
  // Fail fast on missing configuration — never run a money bot half-configured.
  const envReport = validateEnvironment();
  for (const problem of envReport.problems) {
    console.error(`[env] ${problem}`);
  }
  if (!envReport.ok) {
    console.error("[env] Startup aborted — fix the FATAL problems above.");
    process.exit(1);
  }

  app = buildApp();

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

  // Payout status polling — settle or refund transfers stuck in "processing".
  const pollMs = transferPollIntervalMs();
  if (pollMs > 0) {
    setInterval(() => {
      runTransferPolling()
        .then((actions) => {
          for (const a of actions) app.log.info(`[poller] ${a}`);
        })
        .catch((err) => app.log.error("[poller] failed", err));
    }, pollMs);
  }

  // Daily movement digest — every super sees every debit (default 8pm).
  setInterval(() => {
    runDailyDigest().catch((err) => app.log.error("[digest] failed", err));
  }, SCHEDULER_INTERVAL_MS);
}

void main();