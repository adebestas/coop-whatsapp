import Fastify from "fastify";
import type { FastifyError } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import compress from "@fastify/compress";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { webhookRoutes } from "./routes/webhook.js";
import { paymentWebhookRoutes } from "./routes/payments.js";
import { adminApiRoutes } from "./routes/admin.js";
import { developerApiRoutes } from "./routes/developer.js";
import { serveExportFile } from "./routes/exports.js";
import { certificateRoutes } from "./routes/certificate.js";
import { prisma } from "./lib/prisma.js";
import { isRedisConnected } from "./lib/cache.js";
import { incCounter, renderMetrics } from "./lib/metrics.js";
import { isInsecureRequest } from "./lib/http-guards.js";
import { resolveTrustProxy } from "./lib/trust-proxy.js";

declare module "fastify" {
  interface FastifyRequest {
    adminPhone?: string;
    adminCoopId?: string;
    adminRole?: string;
    platformAdmin?: { id: string; phone: string; role: string };
  }
}

/**
 * Directory holding the admin dashboard static files.
 *
 * Previously hardcoded to `/app/dashboard`, which only exists inside the Docker
 * image — every non-container deploy (and the test suite) silently served no
 * dashboard. Resolve relative to this module (`<root>/dashboard` when built to
 * `dist/app.js`, `<root>/dashboard` from source) so it works everywhere, with
 * `DASHBOARD_DIR` as an explicit override.
 */
export function resolveDashboardDir(): string {
  if (process.env.DASHBOARD_DIR) return path.resolve(process.env.DASHBOARD_DIR);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "dashboard");
}

export function buildApp() {
  const app = Fastify({
    logger: true,
    // Trust only the reverse proxy in front of the app. `true` would trust any
    // X-Forwarded-For hop, letting a client forge its IP and bypass IP-based
    // rate limits. See TRUST_PROXY_HOPS for non-standard topologies.
    trustProxy: resolveTrustProxy(process.env.TRUST_PROXY_HOPS),
    bodyLimit: 256 * 1024, // 256 KB
    requestTimeout: 30_000,
    // Force-close keep-alive sockets on app.close() so graceful shutdown can't
    // hang waiting on idle client connections (OPS-1).
    forceCloseConnections: true,
  });

  // One error shape for every route. 5xx responses are generic (no SQL or
  // provider detail leaks) and always carry the request id, so a member's
  // "it just said error" can be found in the logs in one search.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err, reqId: req.id }, "unhandled request error");
    } else {
      req.log.warn({ err, reqId: req.id }, "request rejected");
    }
    return reply.code(status).send({
      error: status >= 500 ? "Something went wrong. Please try again." : err.message,
      requestId: req.id,
    });
  });

  // Compress text responses (dashboard bundles, JSON). The WhatsApp webhook is
  // small, but a branch-office admin on 3G downloads app.js on every visit.
  void app.register(compress, { global: true, threshold: 1024 });

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
        // No 'unsafe-inline' for scripts: the dashboard uses delegated
        // data-action handlers and external scripts only (dashboard/app.js,
        // dashboard/login.js). Inline event handlers are blocked outright.
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
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
      // `req.protocol` honours `trustProxy`; reading X-Forwarded-Proto directly
      // would let a caller forge `https` on a plain-HTTP connection.
      if (isInsecureRequest(req.url, req.protocol)) {
        return reply.code(403).send({ error: "HTTPS required" });
      }
    });
  }

  // CSRF defense in depth for the operator consoles. The auth cookie is
  // SameSite=Strict, but a mutating request carrying a foreign Origin is
  // refused outright. Browser clients always send Origin on POST; CLI/provider
  // callers using bearer tokens send none and are unaffected.
  const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  app.addHook("onRequest", async (req, reply) => {
    if (!MUTATING_METHODS.has(req.method)) return;
    if (!req.url.startsWith("/api/admin") && !req.url.startsWith("/api/developer")) return;
    const origin = req.headers.origin;
    if (!origin) return;
    const sameHost = `${req.protocol}://${req.headers.host}`;
    if (origin !== sameHost && origin !== process.env.DASHBOARD_ORIGIN) {
      return reply.code(403).send({ error: "Cross-site request blocked" });
    }
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
      const dbOk = true;
      const redisOk = isRedisConnected();
      const status = redisOk && dbOk ? "ok" : "degraded";
      const statusCode = status === "ok" ? 200 : 503;
      return reply.code(statusCode).send({ status, db: dbOk, redis: redisOk });
    } catch {
      return reply.status(503).send({ status: "error", message: "Service unavailable" });
    }
  });

  // Prometheus-format metrics. Exposes request volumes, job names and process
  // internals, so in production it is only served when METRICS_TOKEN is set.
  // Protecting it with a token when configured was already the behaviour; the
  // fail-closed default closes the "forgot to set the token" hole.
  app.get("/metrics", async (req, reply) => {
    const token = process.env.METRICS_TOKEN;
    if (!token) {
      if (process.env.NODE_ENV === "production") {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.type("text/plain; version=0.0.4").send(renderMetrics());
    }
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return reply.type("text/plain; version=0.0.4").send(renderMetrics());
  });

  // Count every response by method + status for the metrics endpoint.
  app.addHook("onResponse", async (req, reply) => {
    incCounter("http_requests_total", { method: req.method, status: String(reply.statusCode) });
  });

  app.get("/", async (_req, reply) => {
    return reply.code(200).send({ name: "coop-whatsapp", status: "running", health: "/health" });
  });

  void app.register(webhookRoutes);
  void app.register(paymentWebhookRoutes);
  void app.register(adminApiRoutes);
  void app.register(developerApiRoutes);
  void app.register(serveExportFile);
  void app.register(certificateRoutes);

  // Serve static files — admin dashboard
  const dashboardDir = resolveDashboardDir();
  if (!fs.existsSync(dashboardDir)) {
    console.warn(`[app] Dashboard directory not found at ${dashboardDir} — static files disabled`);
  } else {
    console.log(`[app] Serving dashboard from ${dashboardDir}`);
    void app.register(fastifyStatic, {
      root: dashboardDir,
      prefix: "/dashboard/",
      setHeaders: (res, filePath) => {
        // Operator consoles must never be indexed or cached by intermediaries.
        res.header("X-Robots-Tag", "noindex, nofollow");
        // The HTML shell must revalidate so a deploy is visible immediately;
        // the unhashed JS/CSS can be cached briefly, which removes a full
        // bundle re-download on every navigation.
        res.header(
          "Cache-Control",
          filePath.endsWith(".html") ? "no-cache" : "public, max-age=3600",
        );
      },
    });
    // Redirect /dashboard to /dashboard/ so index.html is served
    app.get("/dashboard", async (_, reply) => reply.redirect("/dashboard/"));
  }

  return app;
}
