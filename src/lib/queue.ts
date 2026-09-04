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

// ===== Queue Singleton =====

const queueMap: Map<string, Queue> = new Map();
const workerMap: Map<string, Worker> = new Map();

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
      console.warn(`[Queue] Processing job ${job.id} in ${queueName}`);
      try {
        await handler(job);
        console.warn(`[Queue] Job ${job.id} completed`);
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
    console.warn(`[Queue] Job ${job.id} completed`);
  });

  workerMap.set(queueName, worker);
}

/**
 * Close all queues and workers
 */
export async function closeQueues(): Promise<void> {
  for (const [name, worker] of workerMap) {
    await worker.close();
    console.warn(`[Queue] Worker ${name} closed`);
  }

  for (const [name, queue] of queueMap) {
    await queue.close();
    console.warn(`[Queue] Queue ${name} closed`);
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
    const { to, message } = job.data;
    // Import dynamically to avoid circular deps
    const { sendText } = await import("./messaging.js");
    await sendText({ to, text: message });
  });

  // NOTE: Payments, exports, backups and digests are executed synchronously by
  // their own services (disbursement/status-poller, export routes, backup
  // scheduler, digest scheduler). No code enqueues to those queues, so they
  // have no processors.

  console.warn("[Queue] All processors initialized");
}
