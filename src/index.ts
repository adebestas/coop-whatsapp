import { buildApp } from "./app.js";
import { config, validateConfig } from "./config.js";
import { startTelegramBot } from "./services/telegram-bot.js";
import {
  runAutoSaveReminders,
  runDailyDigest,
  runMonthlyStatements,
  runBirthdayGreetings,
  runDataRetention,
  runProactiveAlerts,
  runBackupVerificationJob,
} from "./services/scheduler.js";
import { checkAnniversaries } from "./services/anniversary.js";
import { escalateOverdueSTRs } from "./services/aml.js";
import { scanGuarantorDefaults, executeDueDeductions } from "./services/guarantordeduction.js";
import { postAutoStatus } from "./services/status-scheduler.js";
import { cleanupExpiredVirtualAccounts } from "./services/payments/topup.js";
import { runBackup } from "./services/backup.js";
import { runReconciliation } from "./services/reconcile.js";
import { runTransferPolling, transferPollIntervalMs } from "./services/statuspoller.js";
import { validateEnvironment } from "./lib/envcheck.js";
import { prisma } from "./lib/prisma.js";
import { closeQueues, initQueueProcessors } from "./lib/queue.js";
import { initRedis, closeRedis, isRedisConnected, withDistributedLock } from "./lib/cache.js";
import { AlertSeverity, logAndAlert } from "./lib/alerting.js";
import { log } from "./lib/logger.js";
import { rlsEnforcementStatus } from "./lib/tenant-context.js";

const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000; // nightly

// ===== Graceful Shutdown =====
let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info("shutdown started", { signal });

  try {
    // 1. Stop accepting new connections
    await app.close();
    log.info("HTTP server closed");

    // 2. Close queue workers
    await closeQueues();
    log.info("queue workers closed");

    // 3. Disconnect Redis
    await closeRedis();
    log.info("Redis disconnected");

    // 4. Disconnect database
    await prisma.$disconnect();
    log.info("database disconnected");

    log.info("graceful shutdown complete");
    process.exitCode = 0;
  } catch (err) {
    log.error("shutdown error", { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Surface crashes off-box: an unhandled rejection or uncaught exception in a
// money path must not vanish into a container log nobody reads.
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { error: err.message, stack: err.stack });
});

let app: ReturnType<typeof buildApp>;

async function main() {
  // Fail fast on missing configuration — never run a money bot half-configured.
  validateConfig();
  const envReport = validateEnvironment();
  for (const problem of envReport.problems) {
    console.error(`[env] ${problem}`);
  }
  if (!envReport.ok) {
    console.error("[env] Startup aborted — fix the FATAL problems above.");
    process.exit(1);
  }

  app = buildApp();

  // Initialize Redis and verify connectivity
  initRedis();
  await new Promise((r) => setTimeout(r, 500)); // Allow connection attempt
  if (isRedisConnected()) {
    log.info("Redis connectivity verified");
  } else if (process.env.REDIS_URL) {
    log.warn("Redis URL set but not connected — will retry in background");
  } else {
    log.warn("Redis not configured — running without cache");
  }

  // RLS canary: make a half-finished cutover visible instead of assumed.
  try {
    const rls = await rlsEnforcementStatus();
    if (rls.postgres) {
      if (rls.enforced) {
        log.info("RLS enforced for the current role", { policies: rls.policies });
      } else {
        log.warn(
          "RLS policies present but NOT enforced for the current role (table-owner bypass) — tenant isolation is not active",
          { policies: rls.policies },
        );
      }
    }
  } catch (err) {
    log.warn("RLS enforcement check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info(`Coop bot running on http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Telegram runs independently via long-polling — no webhook needed.
  void startTelegramBot();

  // Start BullMQ workers so async jobs (notifications, payments, exports,
  // backups, digests) are actually processed. No-op when Redis is down.
  initQueueProcessors();

  // Background jobs: reminders, monthly statements + birthday greetings,
  // guarantor default notices/deductions.
  let schedulerRunning = false;
  async function runSchedulerLoop() {
    while (true) {
      await new Promise((r) => setTimeout(r, SCHEDULER_INTERVAL_MS));
      if (schedulerRunning) {
        log.warn("[scheduler] previous iteration still running, skipping");
        continue;
      }
      schedulerRunning = true;
      try {
        // Distributed lock: with multiple instances, exactly one runs the tick.
        await withDistributedLock("scheduler:tick", SCHEDULER_INTERVAL_MS, async () => {
          await runAutoSaveReminders().catch((err) =>
            app.log.error("[scheduler] auto-save reminders failed", err),
          );
          await runMonthlyStatements().catch((err) =>
            app.log.error("[scheduler] monthly statements failed", err),
          );
          await runBirthdayGreetings().catch((err) =>
            app.log.error("[scheduler] birthday greetings failed", err),
          );
          await checkAnniversaries().catch((err) =>
            app.log.error("[scheduler] anniversary greetings failed", err),
          );
          await scanGuarantorDefaults()
            .then(async (n) => {
              if (n > 0) {
                // Critical: guarantor default deductions move money — alert on failure
                await logAndAlert(
                  "system",
                  "executeDueDeductions (guarantor default deductions)",
                  async () => {
                    await executeDueDeductions();
                  },
                  AlertSeverity.CRITICAL,
                );
              }
            })
            .catch((err) => app.log.error("[scheduler] guarantor default scan failed", err));
          await postAutoStatus().catch((err) =>
            app.log.error("[scheduler] status auto-post failed", err),
          );
          await cleanupExpiredVirtualAccounts().catch((err) =>
            app.log.error("[scheduler] virtual account cleanup failed", err),
          );
          await runDataRetention().catch((err) =>
            app.log.error("[scheduler] data retention failed", err),
          );
          await escalateOverdueSTRs().catch((err) =>
            app.log.error("[scheduler] STR deadline escalation failed", err),
          );
          await runProactiveAlerts().catch((err) =>
            app.log.error("[scheduler] proactive alerts failed", err),
          );
          await runBackupVerificationJob().catch((err) =>
            app.log.error("[scheduler] backup verification failed", err),
          );
        });
      } finally {
        schedulerRunning = false;
      }
    }
  }
  void runSchedulerLoop();

  // Data-loss protection: full backup every day, plus one at startup.
  void runBackup();
  async function runBackupLoop() {
    while (true) {
      await new Promise((r) => setTimeout(r, BACKUP_INTERVAL_MS));
      await withDistributedLock("scheduler:backup", 60 * 60 * 1000, async () => {
        await logAndAlert(
          "system",
          "runBackup (daily backup)",
          async () => {
            await runBackup();
          },
          AlertSeverity.CRITICAL,
        );
      });
    }
  }
  void runBackupLoop();

  // Nightly reconciliation + anomaly alerts to super admins.
  async function runReconcileLoop() {
    while (true) {
      await new Promise((r) => setTimeout(r, RECONCILE_INTERVAL_MS));
      await withDistributedLock("scheduler:reconcile", 60 * 60 * 1000, async () => {
        await logAndAlert(
          "system",
          "runReconciliation (nightly reconciliation)",
          async () => {
            await runReconciliation();
          },
          AlertSeverity.CRITICAL,
        );
      });
    }
  }
  void runReconcileLoop();

  // Payout status polling — settle or refund transfers stuck in "processing".
  const pollMs = transferPollIntervalMs();
  if (pollMs > 0) {
    async function runPollerLoop() {
      while (true) {
        await new Promise((r) => setTimeout(r, pollMs));
        await withDistributedLock("scheduler:poller", pollMs, async () => {
          await logAndAlert(
            "system",
            "runTransferPolling (payout status polling)",
            async () => {
              await runTransferPolling();
            },
            AlertSeverity.CRITICAL,
          );
        });
      }
    }
    void runPollerLoop();
  }

  // Daily movement digest — every super sees every debit (default 8pm).
  async function runDigestLoop() {
    while (true) {
      await new Promise((r) => setTimeout(r, SCHEDULER_INTERVAL_MS));
      await withDistributedLock("scheduler:digest", SCHEDULER_INTERVAL_MS, async () => {
        await logAndAlert(
          "system",
          "runDailyDigest (daily movement digest)",
          async () => {
            await runDailyDigest();
          },
          AlertSeverity.CRITICAL,
        );
      });
    }
  }
  void runDigestLoop();
}

void main();
