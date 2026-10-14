import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { InsuranceService } from "../services/insurance/index.js";
import { monnifyAdapter } from "./payments/monnify.js";
import { paystackAdapter } from "./payments/paystack.js";
import { flutterwaveAdapter } from "./payments/flutterwave.js";
import { CubeCoverClient } from "./insurance/cubecover.js";
import { handlePaymentNotification } from "./payments/topup.js";
import type { PaymentNotification, ProviderAdapter } from "./payments/index.js";
import { applyDividendPayoutUpdate } from "./dividends.js";
import { applyMandateStatus, settleDebit } from "./mandates.js";
import { withCoopContext, resolveCoopByMandateDebitRef } from "../lib/tenant-context.js";
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
  flutterwave: flutterwaveAdapter,
};

const SIGNATURE_HEADERS: Record<string, string> = {
  "monnify-signature": "monnify",
  "x-paystack-signature": "paystack",
  "verif-hash": "flutterwave",
};

export function detectProvider(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  // CubeCover carries its OWN signature header, checked FIRST so it is never
  // confused with Flutterwave's `verif-hash` (both would otherwise collide, and
  // the Flutterwave mapping below would silently win). NOTE: the header name is
  // INFERRED — confirm against CubeCover's developer docs during onboarding.
  const ccSig = headers["x-cubecover-signature"];
  if ((Array.isArray(ccSig) ? ccSig[0] : ccSig)?.length) return "cubecover";

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
 * True when `reference` belongs to one of OUR direct-debit mandate debits
 * (matched by `MandateDebit.providerRef`). Paystack can deliver a partial debit
 * shaped as a `charge.success`, which the credit parser matches first — this
 * lets us route that event to `settleDebit` instead of the top-up path (where an
 * unknown virtual account would silently no-op and the debit would be retried
 * and re-charged).
 */
async function isMandateDebitReference(reference: string | undefined): Promise<boolean> {
  if (!reference) return false;
  const coopId = await resolveCoopByMandateDebitRef(reference);
  if (!coopId) return false;
  return withCoopContext(coopId, async () => {
    const debit = await prisma.mandateDebit.findUnique({
      where: { providerRef: reference },
      select: { id: true },
    });
    return Boolean(debit);
  });
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

/**
 * CubeCover insurance webhook branch.
 *
 * CubeCover is NOT a payment provider, so it is deliberately kept out of the
 * ProviderAdapter pipeline. It carries its own signature header (see
 * detectProvider) and is verified + processed here. NOTE: the header name and
 * HMAC scheme are INFERRED from CubeCover's public material — confirm against
 * their developer docs during onboarding.
 */
async function handleCubeCoverWebhook(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<WebhookOutcome> {
  const client = new CubeCoverClient({
    apiKey: process.env.CUBECOVER_API_KEY ?? "",
    baseUrl: process.env.CUBECOVER_BASE_URL || "https://api.cubecover.ai",
    webhookSecret: process.env.CUBECOVER_WEBHOOK_SECRET ?? "",
  });

  const sigHeader = headers["x-cubecover-signature"];
  const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  if (!client.verifyWebhook(rawBody, signature)) {
    incCounter("webhook_signature_failures_total", { provider: "cubecover", endpoint: "credit" });
    log.error("webhook signature verification failed", {
      provider: "cubecover",
      endpoint: "credit",
    });
    return { httpStatus: 401, body: { error: "invalid signature" } };
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return { httpStatus: 400, body: { error: "invalid json" } };
  }

  const notification = client.parseNotification(parsedBody);
  if (!notification) {
    return { httpStatus: 200, body: { status: "ignored" } };
  }

  const eventId = `cubecover:${notification.event}:${JSON.stringify(notification.data)}`;
  // Record the delivery BEFORE processing so a duplicate delivery is rejected by
  // the unique constraint instead of re-applying the update.
  try {
    await prisma.webhookEvent.create({
      data: {
        id: eventId,
        provider: "cubecover",
        kind: "insurance_update",
        payloadHash: createHash("sha256").update(rawBody).digest("hex"),
        status: "processed",
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      return { httpStatus: 200, body: { status: "duplicate", event: eventId } };
    }
    console.error(`[webhook] failed to record insurance delivery`, err);
    return { httpStatus: 500, body: { error: "failed to record delivery" } };
  }

  const insuranceService = new InsuranceService({ prisma: prisma as any, cubecover: client });
  try {
    await insuranceService.handleWebhook(notification.event, notification.data);
  } catch (err) {
    // Roll back the dedupe marker so the provider's retry is processed.
    await prisma.webhookEvent.delete({ where: { id: eventId } }).catch(() => {});
    throw err;
  }
  return { httpStatus: 200, body: { status: "ok", event: eventId } };
}

export async function processPaymentWebhook(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<WebhookOutcome> {
  const providerName = detectProvider(headers);
  if (!providerName) {
    return { httpStatus: 400, body: { error: "no recognizable provider signature header" } };
  }

  // CubeCover insurance webhook — NOT a payment provider, so it bypasses the
  // ProviderAdapter pipeline and is verified/handled by its own branch.
  if (providerName === "cubecover") {
    return handleCubeCoverWebhook(rawBody, headers);
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
        // Include the status so a later lifecycle event (e.g. ACTIVATED then
        // CANCELLED) is not suppressed as a duplicate of the earlier one.
        eventId: `${providerName}:mandate:${mandate.providerMandateId}:${mandate.status}`,
        kind: "mandate_update",
        rawBody,
        providerName,
        endpoint: "credit",
        run: () =>
          applyMandateStatus(mandate.provider, mandate.providerMandateId, mandate.status, {
            providerReference: mandate.providerReference,
            providerCustomerId: mandate.providerCustomerId,
          }),
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

    // Unrecognised event — acknowledge with 200 so the provider stops retrying.
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
    // A direct-debit settlement can arrive shaped as `charge.success`. Its
    // reference is one of OUR mandate-debit refs, so settle it rather than
    // treating it as a wallet top-up (the credit path would find no virtual
    // account and silently no-op, leaving the debit pending for a re-charge).
    if (notification.reference && (await isMandateDebitReference(notification.reference))) {
      await settleDebit(
        notification.provider,
        notification.reference,
        "successful",
        notification.transactionId,
      );
    } else {
      await handlePaymentNotification(notification as PaymentNotification);
    }
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

  // CubeCover is not a payout provider. Yield so the combined route falls
  // through to processPaymentWebhook, which owns the insurance branch.
  if (providerName === "cubecover") {
    return { httpStatus: 200, body: { status: "ignored" } };
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
  // coop-initiated payout. Resolve the owning cooperative first (SECURITY DEFINER
  // resolver bypasses RLS), then confirm inside that tenant's context: if this
  // reference belongs to a MandateDebit it is NOT a dividend payout — yield with
  // "ignored" so the combined route falls through to the mandate/credit pipeline.
  const mandateCoopId = await resolveCoopByMandateDebitRef(update.reference);
  if (mandateCoopId) {
    const mandateDebit = await withCoopContext(mandateCoopId, () =>
      prisma.mandateDebit.findUnique({
        where: { providerRef: update.reference },
        select: { id: true },
      }),
    );
    if (mandateDebit) {
      return { httpStatus: 200, body: { status: "ignored" } };
    }
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
