import type { FastifyInstance } from "fastify";
import { flutterwaveAdapter } from "../services/payments/flutterwave.js";
import { paystackAdapter } from "../services/payments/paystack.js";
import type { ProviderAdapter } from "../services/payments/index.js";
import { handlePaymentNotification } from "../services/payments/topup.js";

const adapters: Record<string, ProviderAdapter> = {
  flutterwave: flutterwaveAdapter,
  paystack: paystackAdapter,
};

/**
 * Provider payment webhooks. Both Flutterwave and Paystack post here;
 * the path selects which adapter parses the payload.
 */
export async function paymentWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/payments/:provider", async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const adapter = adapters[provider.toLowerCase()];
    if (!adapter) {
      return reply.code(404).send({ error: "unknown provider" });
    }

    const body = req.body;
    const headers = req.headers as Record<string, string | string[] | undefined>;

    if (!adapter.verifyWebhook(body, headers)) {
      return reply.code(403).send({ error: "invalid signature" });
    }

    const notification = adapter.parseNotification(body);
    if (notification) {
      // Don't block the response on processing; log errors instead.
      void handlePaymentNotification(notification).catch((err) => {
        app.log.error({ err, provider }, "payment notification handling failed");
      });
    }

    return reply.code(200).send({ status: "ok" });
  });
}