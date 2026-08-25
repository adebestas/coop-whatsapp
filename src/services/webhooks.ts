import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { monnifyAdapter } from "./payments/monnify.js";
import { paystackAdapter } from "./payments/paystack.js";
import { flutterwaveAdapter } from "./payments/flutterwave.js";
import { handlePaymentNotification } from "./payments/topup.js";
import type { PaymentNotification, ProviderAdapter } from "./payments/index.js";

/**
 * Combined payment webhook listener.
 *
 * Every provider (Monnify / Paystack / Flutterwave) posts to ONE endpoint.
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
  flutterwave: flutterwaveAdapter,
};

const SIGNATURE_HEADERS: Record<string, string> = {
  "monnify-signature": "monnify",
  "x-paystack-signature": "paystack",
  "verif-hash": "flutterwave",
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
  if (!notification?.transactionId) {
    return { httpStatus: 400, body: { error: "Missing transaction ID" } };
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
    if (err?.code === "P2002") {
      console.log(`[webhook] duplicate delivery ignored: ${eventId}`);
      return { httpStatus: 200, body: { status: "duplicate", event: eventId } };
    }
    throw err;
  }

  // 4. Process synchronously — a crash here marks the event failed and the
  // operator can replay it; the provider's own retry will hit the dedupe
  // only after it succeeded end-to-end.
  try {
    if (notification) {
      await handlePaymentNotification(notification as PaymentNotification);
    }
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
