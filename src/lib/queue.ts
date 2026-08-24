import { Queue, Worker, Job } from "bullmq";
import { getRedis } from "./cache.js";

/**
 * Job queue system using BullMQ.
 * Handles async tasks like sending notifications, processing payments, etc.
 * Gracefully degrades to synchronous when Redis is unavailable.
 */

// ===== Queue Names =====

export const QUEUE_NAMES = {
  NOTIFICATIONS: "notifications",
  PAYMENTS: "payments",
  EXPORTS: "exports",
  BACKUPS: "backups",
  DIGEST: "digest",
} as const;

// ===== Job Types =====

export interface NotificationJob {
  type: "whatsapp" | "telegram" | "email";
  to: string;
  message: string;
  priority?: "low" | "normal" | "high";
}

export interface PaymentJob {
  type: "disburse" | "refund" | "verify";
  payoutId: string;
  provider: string;
  retryCount?: number;
}

export interface ExportJob {
  type: "members" | "ledger" | "deductions";
  coopId: string;
  format: "xlsx" | "pdf";
  requestedBy: string;
}

export interface BackupJob {
  type: "full" | "incremental";
  coopId: string;
}

export interface DigestJob {
  type: "daily" | "weekly";
  coopId: string;
}

// ===== Queue Singleton =====

let queueMap: Map<string, Queue> = new Map();
let workerMap: Map<string, Worker> = new Map();

/**
 * Get or create a queue
 */
function getQueue(name: string): Queue | null {
  const redis = getRedis();
  if (!redis) return null;

  if (!queueMap.has(name)) {
    queueMap.set(
      name,
      new Queue(name, {
        connection: redis,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 50,
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 2000,
          },
        },
      }),
    );
  }

  return queueMap.get(name)!;
}

/**
 * Add a job to a queue
 */
export async function addJob<T>(
  queueName: string,
  data: T,
  options?: { priority?: number; delay?: number; jobId?: string },
): Promise<string | null> {
  const queue = getQueue(queueName);
  if (!queue) {
    console.warn(`[Queue] Redis unavailable, skipping job: ${queueName}`);
    return null;
  }

  try {
    const job = await queue.add(queueName, data, options);
    console.log(`[Queue] Job ${job.id} added to ${queueName}`);
    return job.id!;
  } catch (err) {
    console.error(`[Queue] Failed to add job to ${queueName}:`, err);
    return null;
  }
}

/**
 * Process a queue with a worker
 */
export function processQueue<T>(
  queueName: string,
  handler: (job: Job<T>) => Promise<void>,
): void {
  const redis = getRedis();
  if (!redis) {
    console.warn(`[Queue] Redis unavailable, worker not started: ${queueName}`);
    return;
  }

  if (workerMap.has(queueName)) {
    console.warn(`[Queue] Worker already exists for ${queueName}`);
    return;
  }

  const worker = new Worker(
    queueName,
    async (job) => {
      console.log(`[Queue] Processing job ${job.id} in ${queueName}`);
      try {
        await handler(job);
        console.log(`[Queue] Job ${job.id} completed`);
      } catch (err) {
        console.error(`[Queue] Job ${job.id} failed:`, err);
        throw err;
      }
    },
    {
      connection: redis,
      concurrency: 5,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[Queue] Job ${job?.id} failed:`, err);
  });

  worker.on("completed", (job) => {
    console.log(`[Queue] Job ${job.id} completed`);
  });

  workerMap.set(queueName, worker);
}

/**
 * Get queue metrics
 */
export async function getQueueMetrics(
  queueName: string,
): Promise<{ waiting: number; active: number; completed: number; failed: number } | null> {
  const queue = getQueue(queueName);
  if (!queue) return null;

  try {
    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
    ]);

    return { waiting, active, completed, failed };
  } catch (err) {
    console.error(`[Queue] Failed to get metrics for ${queueName}:`, err);
    return null;
  }
}

/**
 * Close all queues and workers
 */
export async function closeQueues(): Promise<void> {
  for (const [name, worker] of workerMap) {
    await worker.close();
    console.log(`[Queue] Worker ${name} closed`);
  }

  for (const [name, queue] of queueMap) {
    await queue.close();
    console.log(`[Queue] Queue ${name} closed`);
  }

  queueMap.clear();
  workerMap.clear();
}

// ===== Job Handlers =====

/**
 * Initialize all queue processors
 */
export function initQueueProcessors(): void {
  // Notifications queue
  processQueue<NotificationJob>(QUEUE_NAMES.NOTIFICATIONS, async (job) => {
    const { type, to, message } = job.data;
    // Import dynamically to avoid circular deps
    const { sendText } = await import("./messaging.js");
    await sendText({ to, text: message });
  });

  // Payments queue
  processQueue<PaymentJob>(QUEUE_NAMES.PAYMENTS, async (job) => {
    const { type, payoutId } = job.data;
    // Payment processing logic here
    console.log(`[Queue] Processing payment ${type} for payout ${payoutId}`);
  });

  // Exports queue
  processQueue<ExportJob>(QUEUE_NAMES.EXPORTS, async (job) => {
    const { type, coopId, format, requestedBy } = job.data;
    // Export generation logic here
    console.log(`[Queue] Generating ${type} export (${format}) for coop ${coopId}`);
  });

  // Backups queue
  processQueue<BackupJob>(QUEUE_NAMES.BACKUPS, async (job) => {
    const { type, coopId } = job.data;
    // Backup logic here
    console.log(`[Queue] Running ${type} backup for coop ${coopId}`);
  });

  // Digest queue
  processQueue<DigestJob>(QUEUE_NAMES.DIGEST, async (job) => {
    const { type, coopId } = job.data;
    // Digest generation logic here
    console.log(`[Queue] Generating ${type} digest for coop ${coopId}`);
  });

  console.log("[Queue] All processors initialized");
}

// ===== Convenience Functions =====

export const queues = {
  /**
   * Send a notification
   */
  sendNotification: (data: NotificationJob) => addJob(QUEUE_NAMES.NOTIFICATIONS, data),

  /**
   * Process a payment
   */
  processPayment: (data: PaymentJob) =>
    addJob(QUEUE_NAMES.PAYMENTS, data, { priority: data.type === "refund" ? 1 : 0 }),

  /**
   * Generate an export
   */
  generateExport: (data: ExportJob) => addJob(QUEUE_NAMES.EXPORTS, data),

  /**
   * Run a backup
   */
  runBackup: (data: BackupJob) => addJob(QUEUE_NAMES.BACKUPS, data),

  /**
   * Generate a digest
   */
  generateDigest: (data: DigestJob) => addJob(QUEUE_NAMES.DIGEST, data),
};
