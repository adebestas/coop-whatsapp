import { prisma } from "./prisma.js";
import { releaseInboundClaim } from "./inbound-dedupe.js";
import { incCounter } from "./metrics.js";

/**
 * Durable record of an inbound message that failed *after* its dedupe claim was
 * taken. Inbound rows are only written on failure, so the table stays tiny.
 */
const MAX_ERROR_LENGTH = 1000;

export interface WebhookFailureInput {
  channel: string;
  messageId?: string;
  phone?: string;
  error: string;
}

export async function recordWebhookFailure(input: WebhookFailureInput): Promise<void> {
  const error = input.error.slice(0, MAX_ERROR_LENGTH);
  try {
    await prisma.webhookFailure.create({
      data: {
        channel: input.channel,
        messageId: input.messageId ?? null,
        phone: input.phone ?? null,
        error,
      },
    });
  } catch (err) {
    // Failure logging must never mask the original handler error or abort the
    // webhook acknowledgement.
    console.error("[webhook-failure] could not persist failure row", err);
  }
}

/** Delete failure rows older than `retentionDays`; returns the number removed. */
export async function pruneWebhookFailures(retentionDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const res = await prisma.webhookFailure.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return res.count;
}

/**
 * Handle a message that failed after its dedupe claim:
 *  1. release the claim, so the provider retry is not dropped as a duplicate;
 *  2. persist a visible failure row;
 *  3. bump the failure metric.
 * Never throws: the caller is already in a failure path.
 */
export async function failInbound(
  channel: string,
  messageId: string | undefined,
  phone: string | undefined,
  err: unknown,
): Promise<void> {
  const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[${channel}] inbound message failed`, { messageId, phone, error });
  await Promise.allSettled([
    messageId ? releaseInboundClaim(channel, messageId) : Promise.resolve(),
    recordWebhookFailure({ channel, messageId, phone, error }),
  ]);
  incCounter("webhook_processing_failures_total", { channel });
}
