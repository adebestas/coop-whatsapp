import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { monnifyAdapter } from "./payments/monnify.js";
import { paystackAdapter } from "./payments/paystack.js";
import { handlePaymentNotification } from "./payments/topup.js";
import type { PaymentNotification, ProviderAdapter } from "./payments/index.js";
import { applyDividendPayoutUpdate } from "./dividends.js";
import { applyMandateStatus, settleDebit } from "./mandates.js";
import { alertSupers, AlertSeverity } from "../lib/alerting.js";
import { log } from "../lib/logger.js";
import { incCounter } from "../lib/metrics.js";

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

export function detectProvider(
  headers: Record<string, string | string[] | undefined>,
): string | null {
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

/**
 * INSERT-first idempotency + synchronous processing for a single webhook
 * branch. The composite event id is globally unique, so replays are acknowledged
 * but never reprocessed; only fully-`processed` events are acked as duplicates
 * (a previously failed/received delivery is retried). Always 200 for duplicates;
 * 5xx only when recording or processing genuinely failed so the provider retries.
 */
async function recordAndProcess(params: {
  eventId: string;
  kind: string;
  rawBody: string;
  providerName: string;
  endpoint: string;
  run: () => Promise<void>;
}): Promise<WebhookOutcome> {
  const { eventId, kind, rawBody, providerName, endpoint, run } = params;
  try {
    await prisma.webhookEvent.create({
      data: {
        id: eventId,
        provider: providerName,
        kind,
        payloadHash: createHash("sha256").update(rawBody).digest("hex"),
        status: "received",
      },
    });
  } catch (err: any) {
    if (err?.code !== "P2002") {
      console.error(`[webhook] failed to record delivery ${eventId}:`, err);
      return {
        httpStatus: 500,
        body: { status: "failed", error: "could not record webhook event" },
      };
    }
    const existing = await prisma.webhookEvent.findUnique({
      where: { id: eventId },
      select: { status: true },
    });
    if (existing?.status === "processed") {
      console.log(`[webhook] duplicate delivery acked (already processed): ${eventId}`);
      return { httpStatus: 200, body: { status: "duplicate", event: eventId } };
    }
    console.log(
      `[webhook] re-processing previously ${existing?.status ?? "?"} delivery: ${eventId}`,
    );
  }

  try {
    await run();
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: { status: "processed", processedAt: new Date() },
    });
    return { httpStatus: 200, body: { status: "ok", event: eventId } };
  } catch (err: any) {
    console.error(`[webhook] processing failed for ${eventId}`, err);
    incCounter("webhook_processing_failures_total", { provider: providerName, endpoint });
    await alertSupers(
      "system",
      `Webhook processing failed for event ${eventId}\n\nError: ${err?.message ?? "unknown"}`,
      AlertSeverity.CRITICAL,
    ).catch(() => {});
    await prisma.webhookEvent
      .update({
        where: { id: eventId },
        data: { status: "failed", error: String(err?.message ?? err).slice(0, 500) },
      })
      .catch(() => {});
    return { httpStatus: 500, body: { status: "failed", event: eventId } };
  }
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
    // Off-box alert: a signature failure is either tampering or a misconfigured
    // secret — both need a human, and there is no cooperative context to alert.
    incCounter("webhook_signature_failures_total", { provider: providerName, endpoint: "credit" });
    log.error("webhook signature verification failed", {
      provider: providerName,
      endpoint: "credit",
    });
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
    // Direct-debit mandate branch. CRITICAL ordering: the mandate parsers run
    // BEFORE any payout parsing, because Monnify's `parsePayoutNotification` and
    // `parseDebitNotification` match the SAME DISBURSEMENT event set — a
    // mandate-debit webhook must never be consumed as a payout/dividend.
    const mandate = adapter.parseMandateNotification?.(parsedBody) ?? null;
    if (mandate) {
      return recordAndProcess({
        eventId: `${providerName}:mandate:${mandate.providerMandateId}`,
        kind: "mandate_update",
        rawBody,
        providerName,
        endpoint: "credit",
        run: () =>
          applyMandateStatus(mandate.provider, mandate.providerMandateId, mandate.status),
      });
    }

    // Paystack's `parseDebitNotification` also matches generic `charge` events,
    // so it is only reached here — after the credit parser returned null — and
    // never on the normal credit path.
    const debit = adapter.parseDebitNotification?.(parsedBody) ?? null;
    if (debit) {
      return recordAndProcess({
        eventId: `${providerName}:debit:${debit.reference}:${debit.status}`,
        kind: "debit_update",
        rawBody,
        providerName,
        endpoint: "credit",
        run: () =>
          settleDebit(
            debit.provider,
            debit.reference,
            debit.status,
            debit.providerTransactionId,
            debit.reason,
          ),
      });
    }

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
    if (err?.code !== "P2002") {
      // Recording the delivery itself failed (transient DB outage). Return a
      // structured 5xx so the provider retries — never throw, which would
      // surface as a bare 500 with no trace of the attempt.
      console.error(`[webhook] failed to record delivery ${eventId}:`, err);
      return {
        httpStatus: 500,
        body: { status: "failed", error: "could not record webhook event" },
      };
    }
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
    console.log(
      `[webhook] re-processing previously ${existing?.status ?? "?"} delivery: ${eventId}`,
    );
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
    incCounter("webhook_processing_failures_total", { provider: providerName, endpoint: "credit" });
    // Extract cooperativeId from the notification if possible for alerting
    let cooperativeId: string | undefined;
    if (notification && "cooperativeId" in notification) {
      cooperativeId = (notification as any).cooperativeId;
    }

    // Alert super admins if we have cooperative context
    if (cooperativeId) {
      await alertSupers(
        cooperativeId,
        `Webhook processing failed for event ${eventId}\n\nError: ${err?.message ?? "unknown"}`,
        AlertSeverity.CRITICAL,
      ).catch(() => {});
    }

    await prisma.webhookEvent
      .update({
        where: { id: eventId },
        data: { status: "failed", error: String(err?.message ?? err).slice(0, 500) },
      })
      .catch(() => {});
    return { httpStatus: 500, body: { status: "failed", event: eventId } };
  }
}

/**
 * Combined PAYOUT/transfer callback listener.
 *
 * Mirrors processPaymentWebhook but for transfers WE initiated (dividend
 * payouts, etc.): verifies the signature, records the delivery for replay
 * protection, then settles or reverses the corresponding dividend entry via the
 * saga in dividends.ts. Always 200 for irrelevant/duplicate events so the
 * provider stops retrying; 4xx only for signature failures.
 */
export async function processPayoutWebhook(
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

  // Signature first — before parsing or touching the DB.
  if (!adapter.verifyWebhook(rawBody, headers)) {
    incCounter("webhook_signature_failures_total", { provider: providerName, endpoint: "payout" });
    log.error("webhook signature verification failed", {
      provider: providerName,
      endpoint: "payout",
    });
    return { httpStatus: 401, body: { error: "invalid signature" } };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return { httpStatus: 400, body: { error: "invalid json" } };
  }

  const update = adapter.parsePayoutNotification?.(parsedBody) ?? null;
  if (!update) {
    // Not a transfer update (e.g. a charge.success that hit the wrong endpoint).
    return { httpStatus: 200, body: { status: "ignored" } };
  }

  // A Monnify mandate DEBIT shares the DISBURSEMENT event set with a
  // coop-initiated payout. If this reference belongs to a MandateDebit it is NOT
  // a dividend payout — yield with "ignored" so the combined route falls through
  // to the mandate/credit pipeline, which settles it correctly.
  const mandateDebit = await prisma.mandateDebit
    .findUnique({ where: { providerRef: update.reference }, select: { id: true } })
    .catch(() => null);
  if (mandateDebit) {
    return { httpStatus: 200, body: { status: "ignored" } };
  }

  // Include the status in the event id so a failed->success transition (if the
  // provider ever re-sends) is not suppressed as a duplicate of the failure.
  const eventId = `${providerName}:payout:${update.reference}:${update.status}`;

  try {
    await prisma.webhookEvent.create({
      data: {
        id: eventId,
        provider: providerName,
        kind: "payout_update",
        payloadHash: createHash("sha256").update(rawBody).digest("hex"),
        status: "received",
      },
    });
  } catch (err: any) {
    if (err?.code !== "P2002") {
      console.error(`[payout-webhook] failed to record delivery ${eventId}:`, err);
      return {
        httpStatus: 500,
        body: { status: "failed", error: "could not record webhook event" },
      };
    }
    const existing = await prisma.webhookEvent.findUnique({
      where: { id: eventId },
      select: { status: true },
    });
    if (existing?.status === "processed") {
      return { httpStatus: 200, body: { status: "duplicate", event: eventId } };
    }
  }

  try {
    await applyDividendPayoutUpdate({
      provider: update.provider,
      reference: update.reference,
      status: update.status,
      providerRef: update.providerRef,
    });
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: { status: "processed", processedAt: new Date() },
    });
    return { httpStatus: 200, body: { status: "ok", event: eventId } };
  } catch (err: any) {
    console.error(`[payout-webhook] processing failed for ${eventId}`, err);
    incCounter("webhook_processing_failures_total", { provider: providerName, endpoint: "payout" });
    // Best-effort alert: a stuck dividend reversal is a books-integrity issue.
    await alertSupers(
      "system",
      `Payout webhook processing failed for ${eventId}\n\nError: ${err?.message ?? "unknown"}`,
      AlertSeverity.CRITICAL,
    ).catch(() => {});
    await prisma.webhookEvent
      .update({
        where: { id: eventId },
        data: { status: "failed", error: String(err?.message ?? err).slice(0, 500) },
      })
      .catch(() => {});
    return { httpStatus: 500, body: { status: "failed", event: eventId } };
  }
}
