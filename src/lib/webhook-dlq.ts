import { Queue } from "bullmq";
import { prisma } from "./prisma.js";
import { getRedis, isRedisConnected } from "./cache.js";
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from "./queue.js";
import { log } from "./logger.js";
import { incCounter } from "./metrics.js";
import { alertDevelopers } from "./alerting.js";

/**
 * Dead-letter handling for provider webhooks.
 *
 * A webhook is signature-verified BEFORE anything here runs, so a stored
 * payload can be replayed without re-verifying it. The raw body lives on the
 * `WebhookEvent` row (not only in Redis) because Redis is exactly what may be
 * down when the credit fails; BullMQ supplies the delay, the row supplies the
 * durability. If enqueueing fails, a 5-minute scheduler sweep picks the row up.
 */

/** Total process failures (initial + retries) before a delivery is dead. */
export const WEBHOOK_MAX_ATTEMPTS = 6;
/** 5 minutes, doubling per retry, capped at 6 hours. */
export const WEBHOOK_BASE_DELAY_MS = 5 * 60 * 1000;
export const WEBHOOK_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
/** How long a replay claims a row for, so two workers cannot process it twice. */
export const WEBHOOK_LEASE_MS = 10 * 60 * 1000;

/** Delay before the retry that follows failure number `attempt` (1-based). */
export function webhookBackoffMs(attempt: number): number {
  const step = Math.max(1, Math.min(Math.trunc(attempt), 20));
  return Math.min(WEBHOOK_BASE_DELAY_MS * 2 ** (step - 1), WEBHOOK_MAX_DELAY_MS);
}

export interface WebhookFailure {
  eventId: string;
  provider: string;
  kind?: string | null;
  endpoint: "credit" | "payout" | "insurance";
  payload: string;
  error: unknown;
}

/**
 * Mark a verified delivery as failed, schedule its next replay, and alert the
 * operators once the retry budget is exhausted. Never throws: the caller is
 * already in a failure path and must still answer the provider.
 */
export async function scheduleWebhookFailure(failure: WebhookFailure): Promise<void> {
  const { eventId, provider, endpoint, payload, error } = failure;
  const message = String(error instanceof Error ? error.message : error).slice(0, 500);

  let attempts: number;
  try {
    // `deadAt: null` makes this a one-way gate: a delivery that is already dead
    // (or a row that never existed) is never resurrected or re-alerted.
    const incremented = await prisma.webhookEvent.updateMany({
      where: { id: eventId, deadAt: null },
      data: {
        status: "failed",
        error: message,
        endpoint,
        payload,
        attempts: { increment: 1 },
      },
    });
    if (incremented.count === 0) return;
    const row = await prisma.webhookEvent.findUnique({
      where: { id: eventId },
      select: { attempts: true },
    });
    attempts = row?.attempts ?? 0;
  } catch (err) {
    // The row may not exist if recording itself failed; the provider's own
    // retry is the only recovery path then.
    console.error(`[webhook-dlq] could not update ${eventId}`, err);
    return;
  }

  incCounter("webhook_processing_failures_total", {
    provider,
    endpoint,
    attempt: String(attempts),
  });

  if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
    const buried = await prisma.webhookEvent
      .updateMany({
        where: { id: eventId, deadAt: null },
        data: { status: "dead", deadAt: new Date(), nextAttemptAt: null },
      })
      .catch(() => ({ count: 0 }));
    if (buried.count === 0) return; // another worker buried it first
    incCounter("webhook_dlq_dead_total", { provider, endpoint });
    await alertDevelopers(
      `Webhook delivery dead-lettered after ${attempts} attempts: ${eventId}`,
      new Error(message || "unknown error"),
    );
    return;
  }

  const nextAttemptAt = new Date(Date.now() + webhookBackoffMs(attempts));
  await prisma.webhookEvent
    .update({ where: { id: eventId }, data: { nextAttemptAt } })
    .catch(() => {});

  const redis = getRedis();
  if (!redis || !isRedisConnected()) {
    // The 5-minute sweep replays due rows even without Redis.
    log.warn("[webhook-dlq] Redis unavailable; retry left for the scheduler sweep", {
      eventId,
      attempts,
    });
    return;
  }

  const queue = new Queue<{ eventId: string }>(QUEUE_NAMES.WEBHOOK_RETRIES, { connection: redis });
  try {
    await queue.add(
      "replay",
      { eventId },
      {
        delay: webhookBackoffMs(attempts),
        // We manage the attempt budget ourselves (it must survive Redis loss),
        // so BullMQ retrying on its own would double-count.
        attempts: 1,
        jobId: `${eventId.replace(/:/g, "_")}__attempt-${attempts}`,
        removeOnComplete: DEFAULT_JOB_OPTIONS.removeOnComplete,
        removeOnFail: DEFAULT_JOB_OPTIONS.removeOnFail,
      },
    );
  } catch (err) {
    log.error("[webhook-dlq] could not enqueue retry; scheduler sweep will pick it up", {
      eventId,
      err: String(err),
    });
  } finally {
    await queue.close().catch(() => {});
  }
}
