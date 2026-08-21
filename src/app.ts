import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webhookRoutes } from "./routes/webhook.js";
import { paymentWebhookRoutes } from "./routes/payments.js";
import { adminApiRoutes } from "./routes/admin.js";
import { serveExportFile } from "./routes/exports.js";

declare module "fastify" {
  interface FastifyRequest {
    adminPhone?: string;
  }
}

export function buildApp() {
  const app = Fastify({ logger: true });

  // Capture the RAW request body before JSON parsing — provider webhook
  // signatures are computed over the exact bytes sent, so we keep them.
  app.addContentTypeParser<string | Buffer>(
    ["application/json", "text/plain"],
    { parseAs: "string" },
    (req, body, done) => {
      const raw = typeof body === "string" ? body : body.toString("utf8");
      (req as any).rawBody = raw;
      if (req.headers["content-type"]?.includes("application/json")) {
        try {
          done(null, JSON.parse(raw));
        } catch (err: any) {
          err.statusCode = 400;
          done(err, undefined);
        }
      } else {
        done(null, raw);
      }
    },
  );

  void app.register(cors, { origin: true });

  app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

  void app.register(webhookRoutes);
  void app.register(paymentWebhookRoutes);
  void app.register(adminApiRoutes);
  void app.register(serveExportFile);

  // Serve the built admin dashboard (web/dist) if present.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  void app.register(fastifyStatic, { root: webDist });

  return app;
}