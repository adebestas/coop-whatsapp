import { buildApp } from "./app.js";
import { config, validateConfig } from "./config.js";
import { startTelegramBot } from "./services/telegram-bot.js";
import {
  runSchedulerTick,
  runBackupJob,
  runReconcileJob,
  runPollerJob,
  runDigestJob,
} from "./services/scheduler.js";
import { runBackup } from "./services/backup.js";
import { transferPollIntervalMs } from "./services/statuspoller.js";
import { validateEnvironment } from "./lib/envcheck.js";
import { prisma } from "./lib/prisma.js";
import { closeQueues, initQueueProcessors, scheduleSchedulerJobs } from "./lib/queue.js";
import { initRedis, closeRedis, isRedisConnected, withDistributedLock } from "./lib/cache.js";
import { log } from "./lib/logger.js";
import { createShutdown } from "./lib/shutdown.js";
import { rlsEnforcementStatus } from "./lib/tenant-context.js";

const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000; // nightly

let app: ReturnType<typeof buildApp>;

// ===== Graceful Shutdown =====
// Steps run in order; a failure is logged and the process still exits non-zero.
// A watchdog forces exit if a close hangs, so shutdown always terminates even
// though the in-process scheduler/Telegram timers keep the event loop alive.
const { shutdown, isShuttingDown } = createShutdown(
  [
    { name: "HTTP server", close: () => app?.close() },
    { name: "queue workers", close: () => closeQueues() },
    { name: "Redis", close: () => closeRedis() },
    { name: "database", close: () => prisma.$disconnect() },
  ],
  {
    onStart: (signal) => log.info("shutdown started", { signal }),
    onStep: (name) => log.info(`${name} closed`),
    onError: (step, err) =>
      log.error("shutdown error", {
        step,
        error: err instanceof Error ? err.message : String(err),
      }),
    exit: (code) => process.exit(code),
  },
);

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Surface crashes off-box: an unhandled rejection in a money path must not
// vanish into a container log nobody reads. An uncaught exception leaves the
// process in an undefined state, so it must terminate — log, then shut down.
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { error: err.message, stack: err.stack });
  void shutdown("uncaughtException", 1);
});

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

  // RLS canary: a half-finished cutover must be visible, not assumed. In
  // production, refuse to boot without tenant isolation.
  try {
    const rls = await rlsEnforcementStatus();
    if (rls.postgres && !rls.enforced) {
      const msg =
        "RLS policies present but NOT enforced for the current role (table-owner bypass) — tenant isolation is not active";
      if (process.env.NODE_ENV === "production") {
        log.error(
          `${msg}; refusing to boot. Provision the coop_app role and set DATABASE_URL (non-owner) + DATABASE_OWNER_URL (see DEPLOY.md).`,
          { policies: rls.policies },
        );
        process.exit(1);
      }
      log.warn(msg, { policies: rls.policies });
    } else if (rls.postgres) {
      log.info("RLS enforced for the current role", { policies: rls.policies });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (process.env.NODE_ENV === "production") {
      log.error("RLS enforcement check failed — refusing to boot", { error: detail });
      process.exit(1);
    }
    log.warn("RLS enforcement check failed", { error: detail });
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

  // Scheduler: BullMQ repeatable jobs when Redis is available (durable across
  // restarts, exactly one worker per job); otherwise in-process loops.
  if (isRedisConnected()) {
    await scheduleSchedulerJobs();
    log.info("scheduler: BullMQ repeatable jobs registered");
  } else {
    log.warn("scheduler: Redis unavailable — using in-process loops (single instance)");
    startInProcessScheduler();
  }
}

function startInProcessScheduler(): void {
  // Background jobs: reminders, monthly statements + birthday greetings,
  // guarantor default notices/deductions.
  let schedulerRunning = false;
  async function runSchedulerLoop() {
    while (!isShuttingDown()) {
      await new Promise((r) => setTimeout(r, SCHEDULER_INTERVAL_MS));
      if (isShuttingDown()) return;
      if (schedulerRunning) {
        log.warn("[scheduler] previous iteration still running, skipping");
        continue;
      }
      schedulerRunning = true;
      try {
        // Distributed lock: with multiple instances, exactly one runs the tick.
        await withDistributedLock("scheduler:tick", SCHEDULER_INTERVAL_MS, () =>
          runSchedulerTick(),
        );
      } finally {
        schedulerRunning = false;
      }
    }
  }
  void runSchedulerLoop();

  // Data-loss protection: full backup every day, plus one at startup.
  void runBackup();
  async function runBackupLoop() {
    while (!isShuttingDown()) {
      await new Promise((r) => setTimeout(r, BACKUP_INTERVAL_MS));
      if (isShuttingDown()) return;
      await withDistributedLock("scheduler:backup", 60 * 60 * 1000, () => runBackupJob());
    }
  }
  void runBackupLoop();

  // Nightly reconciliation + anomaly alerts to super admins.
  async function runReconcileLoop() {
    while (!isShuttingDown()) {
      await new Promise((r) => setTimeout(r, RECONCILE_INTERVAL_MS));
      if (isShuttingDown()) return;
      await withDistributedLock("scheduler:reconcile", 60 * 60 * 1000, () => runReconcileJob());
    }
  }
  void runReconcileLoop();

  // Payout status polling — settle or refund transfers stuck in "processing".
  const pollMs = transferPollIntervalMs();
  if (pollMs > 0) {
    async function runPollerLoop() {
      while (!isShuttingDown()) {
        await new Promise((r) => setTimeout(r, pollMs));
        if (isShuttingDown()) return;
        await withDistributedLock("scheduler:poller", pollMs, () => runPollerJob());
      }
    }
    void runPollerLoop();
  }

  // Daily movement digest — every super sees every debit (default 8pm).
  async function runDigestLoop() {
    while (!isShuttingDown()) {
      await new Promise((r) => setTimeout(r, SCHEDULER_INTERVAL_MS));
      if (isShuttingDown()) return;
      await withDistributedLock("scheduler:digest", SCHEDULER_INTERVAL_MS, () => runDigestJob());
    }
  }
  void runDigestLoop();
}

void main();
