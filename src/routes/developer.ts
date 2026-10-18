import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../lib/prisma.js";
import { hashPin, verifyPin } from "../lib/security.js";
import { checkRateLimit, resetRateLimit } from "../lib/cache.js";
import { verifyTotp, otpauthUri } from "../lib/totp.js";
import {
  PLATFORM_COOKIE,
  PLATFORM_TTL_MS,
  signPlatformToken,
  verifyPlatformToken,
  revokePlatformToken,
  isPlatformTokenRevoked,
  requireLivePlatformAdmin,
} from "../lib/platform-auth.js";

const MAX_IP_ATTEMPTS = 5;
const IP_WINDOW_SECONDS = 60;
const MAX_ACCOUNT_ATTEMPTS = 10;
const ACCOUNT_WINDOW_SECONDS = 15 * 60;

function setPlatformCookie(reply: FastifyReply, token: string): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  reply.header(
    "Set-Cookie",
    `${PLATFORM_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(PLATFORM_TTL_MS / 1000)}${secure}`,
  );
}

function clearPlatformCookie(reply: FastifyReply): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  reply.header(
    "Set-Cookie",
    `${PLATFORM_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure}`,
  );
}

function readPlatformToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === PLATFORM_COOKIE) return part.slice(idx + 1) || null;
  }
  return null;
}

function platformOtpauthUri(secret: string, phone: string): string {
  return otpauthUri(secret, phone, "CoopPlatform");
}

export async function developerApiRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    if (req.method === "POST" && req.url === "/api/developer/login") return;

    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const requestedWith = req.headers["x-requested-with"];
      const rw = Array.isArray(requestedWith) ? requestedWith[0] : requestedWith;
      if (!rw || rw.toLowerCase() !== "xmlhttprequest") {
        return reply.code(403).send({ error: "Missing X-Requested-With header" });
      }
    }

    const rawToken = readPlatformToken(req);
    const payload = rawToken ? verifyPlatformToken(rawToken) : null;
    if (!payload || !rawToken) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    let revoked: boolean;
    try {
      revoked = await isPlatformTokenRevoked(rawToken);
    } catch (err) {
      console.error("[developer] revocation check failed; failing closed", err);
      revoked = true;
    }
    if (revoked) {
      return reply.code(401).send({ error: "token revoked" });
    }

    let live: Awaited<ReturnType<typeof requireLivePlatformAdmin>>;
    try {
      live = await requireLivePlatformAdmin(payload);
    } catch (err) {
      console.error("[developer] live admin check failed; failing closed", err);
      live = null;
    }
    if (!live) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    if (live.mustChangePin) {
      const isChangePin = method === "POST" && req.url === "/api/developer/change-pin";
      const isLogout = method === "POST" && req.url === "/api/developer/logout";
      const isMe = method === "GET" && req.url === "/api/developer/me";
      if (!isChangePin && !isLogout && !isMe) {
        return reply.code(403).send({ error: "pin_change_required" });
      }
    }

    if (live.role === "support" && method !== "GET" && method !== "HEAD") {
      return reply.code(403).send({ error: "support role is read-only" });
    }

    req.platformAdmin = { id: live.id, phone: live.phone, role: live.role };
  });

  app.post("/api/developer/login", async (req, reply) => {
    const body = req.body as { phone?: string; pin?: string; totp?: string };
    const phone = body.phone?.replace(/[^0-9]/g, "");
    const pin = body.pin;
    const ip = req.ip;

    const ipLimit = await checkRateLimit(`devlogin:${ip}`, MAX_IP_ATTEMPTS, IP_WINDOW_SECONDS);
    if (!ipLimit.allowed) {
      return reply
        .code(429)
        .send({ error: "Too many login attempts", retryAfter: ipLimit.retryAfter });
    }
    if (phone) {
      const acctLimit = await checkRateLimit(
        `devacct:${phone}`,
        MAX_ACCOUNT_ATTEMPTS,
        ACCOUNT_WINDOW_SECONDS,
      );
      if (!acctLimit.allowed) {
        return reply
          .code(429)
          .send({ error: "Too many login attempts", retryAfter: acctLimit.retryAfter });
      }
    }

    if (!phone || !pin) {
      return reply.code(400).send({ error: "phone and pin required" });
    }

    const admin = await prisma.platformAdmin.findUnique({ where: { phone } });
    if (!admin || !admin.active || !admin.pin || !verifyPin(pin, admin.pin)) {
      return reply.code(401).send({ error: "invalid credentials" });
    }

    if (admin.totpEnabled) {
      if (!admin.totpSecret || !body.totp || !verifyTotp(admin.totpSecret, body.totp)) {
        return reply.code(401).send({ error: "invalid 2FA code" });
      }
    }

    await resetRateLimit(`devacct:${phone}`);
    await prisma.platformAdmin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    const token = signPlatformToken({ id: admin.id, phone: admin.phone, role: admin.role });
    setPlatformCookie(reply, token);

    if (admin.mustChangePin) {
      return { mustChangePin: true, token };
    }
    return { admin: { id: admin.id, name: admin.name, phone: admin.phone, role: admin.role } };
  });

  app.post("/api/developer/change-pin", async (req, reply) => {
    const platformAdmin = req.platformAdmin!;
    const body = (req.body ?? {}) as { newPin?: string };
    const newPin = String(body.newPin ?? "");
    if (!/^\d{6}$/.test(newPin)) {
      return reply.code(400).send({ error: "newPin must be exactly 6 digits" });
    }
    await prisma.platformAdmin.update({
      where: { id: platformAdmin.id },
      data: { pin: hashPin(newPin), mustChangePin: false },
    });
    return { ok: true };
  });

  app.post("/api/developer/setup-2fa", async (req, reply) => {
    const platformAdmin = req.platformAdmin!;
    const body = (req.body ?? {}) as { secret?: string; code?: string };
    const secret = String(body.secret ?? "")
      .replace(/\s/g, "")
      .toUpperCase();
    const code = String(body.code ?? "");
    if (!secret || !code || !verifyTotp(secret, code)) {
      return reply.code(400).send({ error: "invalid 2FA code" });
    }
    await prisma.platformAdmin.update({
      where: { id: platformAdmin.id },
      data: { totpSecret: secret, totpEnabled: true },
    });
    return { ok: true, otpauthUri: platformOtpauthUri(secret, platformAdmin.phone) };
  });

  app.post("/api/developer/logout", async (req, reply) => {
    const rawToken = readPlatformToken(req);
    if (rawToken) {
      try {
        await revokePlatformToken(rawToken);
      } catch (err) {
        console.error("[developer] logout revoke failed", err);
      }
    }
    clearPlatformCookie(reply);
    return reply.code(200).send({ ok: true });
  });

  app.post("/api/developer/refresh", async (req, reply) => {
    const platformAdmin = req.platformAdmin!;
    const token = signPlatformToken({
      id: platformAdmin.id,
      phone: platformAdmin.phone,
      role: platformAdmin.role,
    });
    setPlatformCookie(reply, token);
    return { ok: true };
  });

  app.get("/api/developer/me", async (req, reply) => {
    const platformAdmin = req.platformAdmin!;
    const admin = await prisma.platformAdmin.findUnique({ where: { id: platformAdmin.id } });
    if (!admin) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return { admin: { id: admin.id, name: admin.name, phone: admin.phone, role: admin.role } };
  });

  app.all("/api/developer/*", async (_req, reply) => {
    return reply.code(404).send({ error: "Not found" });
  });
}
