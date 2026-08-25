import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webhookRoutes } from "./routes/webhook.js";
import { paymentWebhookRoutes } from "./routes/payments.js";
import { adminApiRoutes } from "./routes/admin.js";
import { serveExportFile } from "./routes/exports.js";
import { prisma } from "./lib/prisma.js";
import { getRedis } from "./lib/cache.js";

declare module "fastify" {
  interface FastifyRequest {
    adminPhone?: string;
    adminCoopId?: string;
    adminRole?: string;
  }
}

export function buildApp() {
  const app = Fastify({
    logger: true,
    // Trust the reverse proxy (nginx/caddy) for correct client IPs in rate limits.
    trustProxy: true,
  });

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

  // Restrict CORS to actual dashboard origin (prevents cross-site attacks)
  const dashboardOrigin = process.env.DASHBOARD_ORIGIN;
  void app.register(cors, {
    origin: dashboardOrigin ? [dashboardOrigin] : false,
    credentials: true,
  });

  // Security headers — defense in depth against XSS, clickjacking, etc.
  void app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false, // Allow WhatsApp webhook images
    crossOriginResourcePolicy: { policy: "cross-origin" },
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
  });

  // Rate limiting — blunt-force protection on every public route.
  // Providers retry aggressively, so webhooks get a generous but bounded
  // budget; everything else is tight.
  const isTest = process.env.NODE_ENV === "test";
  void app.register(rateLimit, {
    global: true,
    max: isTest ? 10_000 : 120,
    timeWindow: "1 minute",
  });

  app.get("/health", async (req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      const redis = getRedis();
      if (redis) await redis.ping();
      return { status: "ok", db: "connected", redis: redis ? "connected" : "unavailable" };
    } catch {
      return reply.status(503).send({ status: "error", message: "Service unavailable" });
    }
  });

  void app.register(webhookRoutes);
  void app.register(paymentWebhookRoutes);
  void app.register(adminApiRoutes);
  void app.register(serveExportFile);

  // Serve the admin dashboard (dashboard/) if present.
  const dashboardDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dashboard");
  void app.register(fastifyStatic, { root: dashboardDir, prefix: "/dashboard/" });

  // Serve the built admin dashboard (web/dist) if present.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  void app.register(fastifyStatic, { root: webDist });

  return app;
}