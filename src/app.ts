import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webhookRoutes } from "./routes/webhook.js";
import { paymentWebhookRoutes } from "./routes/payments.js";
import { adminApiRoutes } from "./routes/admin.js";

declare module "fastify" {
  interface FastifyRequest {
    adminPhone?: string;
  }
}

export function buildApp() {
  const app = Fastify({ logger: true });

  void app.register(cors, { origin: true });

  app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

  void app.register(webhookRoutes);
  void app.register(paymentWebhookRoutes);
  void app.register(adminApiRoutes);

  // Serve the built admin dashboard (web/dist) if present.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  void app.register(fastifyStatic, { root: webDist });

  return app;
}