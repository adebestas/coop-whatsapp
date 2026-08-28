import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { monnifyAdapter } from "./payments/monnify.js";
import { paystackAdapter } from "./payments/paystack.js";
import { handlePaymentNotification } from "./payments/topup.js";
import type { PaymentNotification, ProviderAdapter } from "./payments/index.js";

/**
 * Combined payment webhook listener.
 *
 * Every provider (Monnify / Paystack) posts to ONE endpoint.
 * Processing pipeline, in order:
 *   1. Identify the provider by its signature header.
 *   2. Verify the cryptographic signature over the RAW request body
 *      (timing-safe; fail closed when unconfigured).
 *   3. Record the delivery in WebhookEvent (INSERT-first). The composite
 *      event id is globally unique, so retries/replays are acknowledged but
 *      never reprocessed — permanent anti-replay window.
 *   4. Parse + process the notification synchronously and mark the event.
 *
 * The endpoint always answers 200 for duplicates (providers stop retrying)
 * and 4xx for signature failures (so tampering shows up in their dashboards).
 */

const adapters: Record<string, ProviderAdapter> = {
  monnify: monnifyAdapter,
  paystack: paystackAdapter,
};

const SIGNATURE_HEADERS: Record<string, string> = {
  "monnify-signature": "monnify",
  "x-paystack-signature": "paystack",
};

export function detectProvider(headers: Record<string, string | string[] | undefined>): string | null {
  for (const [header, provider] of Object.entries(SIGNATURE_HEADERS)) {
    const value = headers[header];
    if ((Array.isArray(value) ? value[0] : value)?.length) return provider;
  }
  return null;
}

export interface WebhookOutcome {
  httpStatus: number;
  body: Record<string, unknown>;
}

export async function processPaymentWebhook(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<WebhookOutcome> {
  const providerName = detectProvider(headers);
  if (!providerName) {
    return { httpStatus: 400, body: { error: "no recognizable provider signature header" } };
  }
  const adapter = adapters[providerName];
  if (!adapter) {
    return { httpStatus: 400, body: { error: `unknown provider ${providerName}` } };
  }

  // 1. Signature check over the RAW bytes — before any parsing or DB access.
  if (!adapter.verifyWebhook(rawBody, headers)) {
    console.error(`[webhook] INVALID signature from ${providerName}`);
    return { httpStatus: 401, body: { error: "invalid signature" } };
  }

  // 2. Event id — the provider's transaction id is the natural dedupe key.
  let parsedBody: any;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return { httpStatus: 400, body: { error: "invalid json" } };
  }
  const notification = adapter.parseNotification(parsedBody);
  if (!notification) {
    // Recognised event, but not a credit we act on (e.g. charge.failed,
    // transfer.success for a coop-initiated payout, or a provider health
    // ping). Acknowledge with 200 so the provider stops retrying — never
    // 4xx, which would make them hammer us.
    return { httpStatus: 200, body: { status: "ignored" } };
  }

  const eventId = `${providerName}:${notification.transactionId}`;

  // 3. INSERT-first idempotency gate.
  try {
    await prisma.webhookEvent.create({
      data: {
        id: eventId,
        provider: providerName,
        kind: notification ? "credit" : "ignored",
        payloadHash: createHash("sha256").update(rawBody).digest("hex"),
        status: "received",
      },
    });
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;
    // Already seen this delivery. Only ack as "duplicate" when it fully
    // succeeded end-to-end; otherwise a previously FAILED (or still
    // "received") event must be reprocessed on the provider's retry —
    // otherwise we'd acknowledge-and-lose real funds that never credited.
    const existing = await prisma.webhookEvent.findUnique({
      where: { id: eventId },
      select: { status: true },
    });
    if (existing?.status === "processed") {
      console.log(`[webhook] duplicate delivery acked (already processed): ${eventId}`);
      return { httpStatus: 200, body: { status: "duplicate", event: eventId } };
    }
    // Reprocess failed/received deliveries instead of acknowledging them.
    console.log(`[webhook] re-processing previously ${existing?.status ?? "?"} delivery: ${eventId}`);
  }

  // 4. Process synchronously — a crash here marks the event failed and the
  // provider's own retry (or a manual re-delivery) reprocesses it below; only
  // fully-processed events are acked as "duplicate".
  try {
    await handlePaymentNotification(notification as PaymentNotification);
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: { status: "processed", processedAt: new Date() },
    });
    return { httpStatus: 200, body: { status: "ok", event: eventId } };
  } catch (err: any) {
    console.error(`[webhook] processing failed for ${eventId}`, err);
    await prisma.webhookEvent
      .update({
        where: { id: eventId },
        data: { status: "failed", error: String(err?.message ?? err).slice(0, 500) },
      })
      .catch(() => {});
    return { httpStatus: 500, body: { status: "failed", event: eventId } };
  }
}
