import type { FastifyInstance } from "fastify";
import { processPaymentWebhook, processPayoutWebhook } from "../services/webhooks.js";

/**
 * Combined provider webhook (Monnify + Paystack) for BOTH credits and payouts.
 * The provider is detected by its signature header and verified against the
 * RAW request body; deliveries are deduplicated in WebhookEvent before any
 * processing. A transfer/payout event is routed to the payout saga; anything
 * else falls through to the credit handler. Legacy per-provider paths are
 * aliased onto the same handler.
 */
export async function paymentWebhookRoutes(app: FastifyInstance) {
  async function handle(req: any, reply: any) {
    const rawBody = (req as any).rawBody;
    if (typeof rawBody !== "string") {
      return reply.code(400).send({ error: "raw body unavailable" });
    }
    try {
      // Transfer events (transfer.success/failed) settle or reverse dividend
      // payouts. Non-payout events return status "ignored" and fall through.
      const payout = await processPayoutWebhook(rawBody, req.headers as Record<string, string>);
      if (payout.body.status !== "ignored") {
        return reply.code(payout.httpStatus).send(payout.body);
      }
      const outcome = await processPaymentWebhook(rawBody, req.headers as Record<string, string>);
      return reply.code(outcome.httpStatus).send(outcome.body);
    } catch (err) {
      req.log?.error?.({ err }, "payment webhook handler crashed");
      return reply.code(500).send({ error: "internal webhook error" });
    }
  }

  app.post("/webhooks/payments", handle);
  // Backward-compatible aliases for providers already configured per-path.
  app.post("/webhooks/payments/:provider", handle);
  app.post("/webhooks/payouts", handle);
}
