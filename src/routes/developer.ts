import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../lib/prisma.js";
import { hashPin, verifyPin } from "../lib/security.js";
import { checkRateLimit, resetRateLimit } from "../lib/cache.js";
import { normalizePhone } from "../lib/phones.js";
import { withCoopContext } from "../lib/tenant-context.js";
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
import {
  createCoop,
  getCoopDetail,
  setCoopStatus,
  revokeCoopSessions,
  addCoopAdminAndNotify,
  setCoopAdminRole,
  setCoopCompliance,
  ComplianceInputError,
  coopExists,
  type PlatformActor,
  type CreateCoopInput,
  type CoopComplianceInput,
} from "../services/platform-coops.js";
import { coopStats, platformOverview, coopActivity } from "../services/platform-monitoring.js";
import {
  listPlatformAdmins,
  createPlatformAdmin,
  setPlatformAdmin,
} from "../services/platform-admin.js";
import { listPlatformPolicies, setPlatformPolicy } from "../services/platform-policy.js";
import { writePlatformAudit } from "../services/platform-audit.js";
import {
  generateReport,
  listReports,
  markFiled,
  getRegulatorProfile,
} from "../services/regulator-reporting.js";

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

/** Actor for the platform audit trail, taken from the authenticated preHandler. */
function actorOf(req: FastifyRequest): PlatformActor {
  const admin = req.platformAdmin!;
  return { id: admin.id, phone: admin.phone, role: admin.role };
}

/** Platform-admin management is owner-only (spec §8). */
function requireOwner(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.platformAdmin?.role !== "owner") {
    reply.code(403).send({ error: "owner role required" });
    return false;
  }
  return true;
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
    const phone = body.phone ? normalizePhone(body.phone) : null;
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

  // ---- Cooperative provisioning & control (developer/owner) ----

  app.get("/api/developer/overview", async () => platformOverview());

  app.get("/api/developer/coops", async () => {
    const { coops, alerts } = await platformOverview();
    return { coops, alerts };
  });

  app.post("/api/developer/coops", async (req, reply) => {
    const body = (req.body ?? {}) as CreateCoopInput;
    if (!body.name || !body.code) {
      return reply.code(400).send({ error: "name and code required" });
    }
    const adminPhone = normalizePhone(body.superAdmin?.phone ?? body.adminPhone ?? "");
    if (!adminPhone) {
      return reply.code(400).send({ error: "a valid superAdmin.phone is required" });
    }
    // The creator's channel phone is NOT client-supplied: provisioning uses the
    // admin phone as the member identity, so a body field must not be able to
    // point the super-admin row at an unrelated session.
    const { sessionPhone, ...safeBody } = body as CreateCoopInput & { sessionPhone?: unknown };
    void sessionPhone;
    try {
      const result = await createCoop(
        {
          ...safeBody,
          adminPhone,
          superAdmin: body.superAdmin ? { ...body.superAdmin, phone: adminPhone } : undefined,
        },
        actorOf(req),
      );
      return reply.code(200).send(result);
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        return reply.code(409).send({ error: "cooperative code already exists" });
      }
      if (err instanceof ComplianceInputError) {
        return reply.code(400).send({ error: err.message });
      }
      req.log.error(err);
      return reply.code(500).send({ error: "failed to create cooperative" });
    }
  });

  app.get("/api/developer/coops/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = await getCoopDetail(id);
    if (!detail) return reply.code(404).send({ error: "not found" });
    return { ...detail, stats: await coopStats(id) };
  });

  app.get("/api/developer/coops/:id/activity", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { take } = req.query as { take?: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "not found" });
    const parsed = Number.parseInt(take ?? "", 10);
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 15;
    return { entries: await coopActivity(id, limit) };
  });

  // Nigeria compliance metadata (registration/CVN/TIN/SCUML/DPO) — whitelisted.
  app.patch("/api/developer/coops/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) {
      return reply.code(404).send({ error: "cooperative not found" });
    }
    const body = (req.body ?? {}) as CoopComplianceInput;
    try {
      await setCoopCompliance(id, body, actorOf(req));
    } catch (err) {
      if ((err as { code?: string }).code === "P2025") {
        return reply.code(404).send({ error: "cooperative not found" });
      }
      if (err instanceof ComplianceInputError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
    return { ok: true };
  });

  // ---- Regulator returns (developer/owner) ----

  app.get("/api/developer/coops/:id/regulator-reports", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });
    const data = await withCoopContext(id, async () => {
      const [profile, listed] = await Promise.all([getRegulatorProfile(id), listReports(id)]);
      return { profile, reports: listed.reports ?? [] };
    });
    return data;
  });

  app.post("/api/developer/coops/:id/regulator-reports", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });

    const body = (req.body ?? {}) as { year?: number | string; packType?: string };
    const rawYear = body.year;
    const year =
      typeof rawYear === "number"
        ? rawYear
        : typeof rawYear === "string" && /^\d{4}$/.test(rawYear.trim())
          ? Number(rawYear.trim())
          : NaN;
    const currentYear = new Date().getUTCFullYear();
    if (!Number.isInteger(year) || year < 2000 || year > currentYear) {
      return reply
        .code(400)
        .send({ error: "year must be a four-digit year up to the current year" });
    }
    const packType = body.packType ?? "statutory";
    if (packType !== "statutory" && packType !== "nfiu" && packType !== "both") {
      return reply.code(400).send({ error: "packType must be statutory, nfiu or both" });
    }

    const result = await generateReport(id, String(year), "annual", packType, actorOf(req).id);
    if (!result.ok) return reply.code(400).send({ error: result.message });
    return result;
  });

  app.post("/api/developer/coops/:id/regulator-reports/:reportId/file", async (req, reply) => {
    const { id, reportId } = req.params as { id: string; reportId: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });

    const body = (req.body ?? {}) as { acknowledgementId?: string; note?: string };
    if (body.acknowledgementId !== undefined && typeof body.acknowledgementId !== "string") {
      return reply.code(400).send({ error: "acknowledgementId must be a string" });
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      return reply.code(400).send({ error: "note must be a string" });
    }

    const actor = actorOf(req);
    const result = await withCoopContext(id, () =>
      markFiled(
        id,
        reportId,
        { id: actor.id, phone: actor.phone },
        { acknowledgementId: body.acknowledgementId, note: body.note },
      ),
    );
    if (!result.ok) {
      const notFound = result.message.startsWith("No regulator report matching");
      return reply.code(notFound ? 404 : 400).send({ error: result.message });
    }
    return { ok: true, message: result.message };
  });

  app.post("/api/developer/coops/:id/admins", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { phone?: string; name?: string; role?: string };
    const phone = normalizePhone(body.phone ?? "");
    if (!phone) return reply.code(400).send({ error: "a valid phone is required" });
    const role = body.role === "superadmin" ? "superadmin" : "admin";
    if (!(await coopExists(id))) {
      return reply.code(404).send({ error: "cooperative not found" });
    }
    const result = await addCoopAdminAndNotify(id, { phone, name: body.name, role }, actorOf(req));
    return reply.code(200).send(result);
  });

  app.patch("/api/developer/coops/:id/admins/:memberId", async (req, reply) => {
    const { id, memberId } = req.params as { id: string; memberId: string };
    const body = (req.body ?? {}) as { role?: string };
    if (body.role !== "admin" && body.role !== "superadmin") {
      return reply.code(400).send({ error: "role must be admin or superadmin" });
    }
    try {
      await setCoopAdminRole(id, memberId, body.role, actorOf(req));
    } catch (err) {
      if ((err as { code?: string }).code === "P2025") {
        return reply.code(404).send({ error: "member not found" });
      }
      throw err;
    }
    return { ok: true };
  });

  app.post("/api/developer/coops/:id/suspend", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) {
      return reply.code(404).send({ error: "cooperative not found" });
    }
    await setCoopStatus(id, "suspended", actorOf(req));
    return { ok: true, status: "suspended" };
  });

  app.post("/api/developer/coops/:id/reactivate", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) {
      return reply.code(404).send({ error: "cooperative not found" });
    }
    await setCoopStatus(id, "active", actorOf(req));
    return { ok: true, status: "active" };
  });

  app.post("/api/developer/coops/:id/revoke-sessions", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) {
      return reply.code(404).send({ error: "cooperative not found" });
    }
    await revokeCoopSessions(id, actorOf(req));
    return { ok: true };
  });

  // ---- Platform policies (developer/owner) ----

  app.get("/api/developer/policies", async () => ({ policies: await listPlatformPolicies() }));

  app.get("/api/developer/policies/:key", async (req, reply) => {
    const { key } = req.params as { key: string };
    const found = (await listPlatformPolicies()).find((p) => p.key === key);
    if (!found) return reply.code(404).send({ error: "unknown policy" });
    return found;
  });

  app.put("/api/developer/policies/:key", async (req, reply) => {
    const { key } = req.params as { key: string };
    const body = (req.body ?? {}) as {
      value?: number | boolean | string;
      min?: number;
      max?: number;
      locked?: boolean;
    };
    try {
      await setPlatformPolicy(key, body);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const actor = actorOf(req);
    await writePlatformAudit({
      actorId: actor.id,
      actorPhone: actor.phone,
      actorRole: actor.role,
      action: "policy.set",
      targetType: "platform_policy",
      targetId: key,
      detail: JSON.stringify(body),
    });
    return { ok: true };
  });

  // ---- Platform admins (owner-only, spec §8) ----

  app.get("/api/developer/admins", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    return { admins: await listPlatformAdmins() };
  });

  app.post("/api/developer/admins", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const body = (req.body ?? {}) as { name?: string; phone?: string; role?: string };
    const phone = normalizePhone(body.phone ?? "");
    if (!body.name || !phone) {
      return reply.code(400).send({ error: "name and a valid phone are required" });
    }
    try {
      const admin = await createPlatformAdmin(
        { name: body.name, phone, role: body.role },
        actorOf(req),
      );
      return reply.code(200).send(admin);
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        return reply.code(409).send({ error: "phone already registered" });
      }
      req.log.error(err);
      return reply.code(500).send({ error: "failed to create admin" });
    }
  });

  app.patch("/api/developer/admins/:id", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { role?: string; active?: boolean };
    try {
      return await setPlatformAdmin(id, { role: body.role, active: body.active }, actorOf(req));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "P2025") return reply.code(404).send({ error: "admin not found" });
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.all("/api/developer/*", async (_req, reply) => {
    return reply.code(404).send({ error: "Not found" });
  });
}
