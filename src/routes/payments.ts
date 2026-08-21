import type { FastifyInstance } from "fastify";
import { processPaymentWebhook } from "../services/webhooks.js";

/**
 * Combined provider payment webhook (Monnify + Paystack + Flutterwave).
 * The provider is detected by its signature header and verified against the
 * RAW request body; deliveries are deduplicated in WebhookEvent before any
 * processing. Legacy per-provider paths are aliased onto the same handler.
 */
export async function paymentWebhookRoutes(app: FastifyInstance) {
  async function handle(req: any, reply: any) {
    const rawBody = (req as any).rawBody;
    if (typeof rawBody !== "string") {
      return reply.code(400).send({ error: "raw body unavailable" });
    }
    const outcome = await processPaymentWebhook(rawBody, req.headers as Record<string, string>);
    return reply.code(outcome.httpStatus).send(outcome.body);
  }

  app.post("/webhooks/payments", handle);
  // Backward-compatible aliases for providers already configured per-path.
  app.post("/webhooks/payments/:provider", handle);
}
