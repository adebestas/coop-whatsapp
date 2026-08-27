import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import path from "node:path";
import fs from "node:fs";
import { webhookRoutes } from "./routes/webhook.js";
import { paymentWebhookRoutes } from "./routes/payments.js";
import { adminApiRoutes } from "./routes/admin.js";
import { serveExportFile } from "./routes/exports.js";
import { prisma } from "./lib/prisma.js";
import { getRedis, isRedisConnected } from "./lib/cache.js";

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
    bodyLimit: 256 * 1024, // 256 KB
    requestTimeout: 30_000,
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

  // HTTPS enforcement in production — reject plain HTTP requests at the
  // application layer when behind a reverse proxy that sets x-forwarded-proto.
  if (process.env.NODE_ENV === "production") {
    app.addHook("onRequest", async (req, reply) => {
      if (req.headers["x-forwarded-proto"] !== "https") {
        return reply.code(403).send({ error: "HTTPS required" });
      }
    });
  }

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
      const dbOk = true;
      const redisOk = isRedisConnected();
      const status = redisOk && dbOk ? "ok" : "degraded";
      const statusCode = status === "ok" ? 200 : 503;
      return reply.code(statusCode).send({ status, db: dbOk, redis: redisOk });
    } catch {
      return reply.status(503).send({ status: "error", message: "Service unavailable" });
    }
  });

  app.get("/", async (_req, reply) => {
    return reply.code(200).send({ name: "coop-whatsapp", status: "running", health: "/health" });
  });

  void app.register(webhookRoutes);
  void app.register(paymentWebhookRoutes);
  void app.register(adminApiRoutes);
  void app.register(serveExportFile);

  // Serve static files — admin dashboard
  const dashboardDir = path.join(process.cwd(), "dashboard");
  if (fs.existsSync(dashboardDir)) {
    void app.register(fastifyStatic, { root: dashboardDir, prefix: "/dashboard/" });
  } else {
    console.warn(`[app] Dashboard directory not found at ${dashboardDir} — static files disabled`);
  }

  return app;
}