import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Queue } from "bullmq";
import { prisma } from "../lib/prisma.js";
import { checkRateLimit, getRedis, isRedisConfigured, resetRateLimit } from "../lib/cache.js";
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from "../lib/queue.js";
import { listCooperativeIds, withCoopContext } from "../lib/tenant-context.js";
import { hashPin, verifyPin } from "../lib/security.js";
import { normalizePhone } from "../lib/phones.js";
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
  setCoopConfig,
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
import {
  ComplianceRegisterError,
  createBreach,
  createCrossBorderTransfer,
  createDpia,
  endCrossBorderTransfer,
  listBreaches,
  listCrossBorderTransfers,
  listDpias,
  summariseBreaches,
  updateBreach,
  updateDpia,
  type BreachPatch,
  type BreachInput,
  type CrossBorderInput,
  type DpiaInput,
} from "../services/compliance-registers.js";
import { getSanctionsRefreshStatus, refreshSanctionsList } from "../services/sanctions-refresh.js";
import {
  getSandboxOverview,
  getSandboxState,
  isSandboxPersonaId,
  runSandboxTurn,
  resetSandbox,
  SANDBOX_PERSONAS,
} from "../services/sandbox.js";
import { SandboxBusyError } from "../lib/sandbox-errors.js";

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

function requireSandboxWriter(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.platformAdmin?.role !== "owner" && req.platformAdmin?.role !== "developer") {
    reply.code(403).send({ error: "owner or developer role required" });
    return false;
  }
  return true;
}

async function isSandboxCoop(cooperativeId: string): Promise<boolean> {
  const cooperative = await withCoopContext(cooperativeId, () =>
    prisma.cooperative.findUnique({
      where: { id: cooperativeId },
      select: { isSandbox: true },
    }),
  );
  return cooperative?.isSandbox ?? false;
}

type DiagnosticResult = {
  status: "healthy" | "error" | "not_configured";
  durationMs?: number;
  statusCode?: number;
  message: string;
};

async function probeExternalService(
  url: string,
  init: RequestInit = {},
): Promise<DiagnosticResult> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(6000),
    });
    const status = response.status >= 200 && response.status < 300 ? "healthy" : "error";
    return {
      status,
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      message:
        status === "healthy"
          ? "Connection and credentials verified"
          : "Provider rejected the check",
    };
  } catch {
    return {
      status: "error",
      durationMs: Date.now() - startedAt,
      message: "Connection failed or timed out",
    };
  }
}

function missingDiagnostic(): DiagnosticResult {
  return { status: "not_configured", message: "Credentials are not configured" };
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

  app.get("/api/developer/sanctions", async () => {
    const refresh = await getSanctionsRefreshStatus();
    return { configured: Boolean(process.env.SANCTIONS_LIST_URL), refresh };
  });

  app.post("/api/developer/sanctions/refresh", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const result = await refreshSanctionsList();
    const actor = actorOf(req);
    await writePlatformAudit({
      actorId: actor.id,
      actorPhone: actor.phone,
      actorRole: actor.role,
      action: "sanctions.refresh",
      targetType: "sanctions_list",
      targetId: "global",
      detail: JSON.stringify({
        ok: result.ok,
        fetched: result.fetched ?? 0,
        created: result.created ?? 0,
        updated: result.updated ?? 0,
        deactivated: result.deactivated ?? 0,
        error: result.error ?? null,
      }),
    });
    return reply.code(result.ok ? 200 : 502).send(result);
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

  // Per-cooperative feature flags and configuration rules (developer/owner).
  app.patch("/api/developer/coops/:id/config", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) {
      return reply.code(404).send({ error: "cooperative not found" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = await setCoopConfig(id, body, actorOf(req));
      return reply.code(200).send(result);
    } catch (err) {
      if ((err as { code?: string }).code === "P2025") {
        return reply.code(404).send({ error: "cooperative not found" });
      }
      if (err instanceof ComplianceInputError) {
        return reply.code(400).send({ error: err.message });
      }
      req.log.error(err);
      return reply.code(500).send({ error: "failed to update cooperative configuration" });
    }
  });

  // ---- Regulator returns (developer/owner) ----

  app.get("/api/developer/coops/:id/regulator-reports", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });
    if (await isSandboxCoop(id)) {
      return reply.code(404).send({ error: "regulator reports are unavailable for the sandbox" });
    }
    const data = await withCoopContext(id, async () => {
      const [profile, listed] = await Promise.all([getRegulatorProfile(id), listReports(id)]);
      return { profile, reports: listed.reports ?? [] };
    });
    return data;
  });

  app.post("/api/developer/coops/:id/regulator-reports", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });
    if (await isSandboxCoop(id)) {
      return reply.code(404).send({ error: "regulator reports are unavailable for the sandbox" });
    }

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

    try {
      const result = await generateReport(id, String(year), "annual", packType, actorOf(req).id);
      if (!result.ok) return reply.code(400).send({ error: result.message });
      return result;
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: "failed to generate regulator pack" });
    }
  });

  app.get(
    "/api/developer/coops/:id/regulator-reports/:reportId/download/:kind",
    async (req, reply) => {
      const { id, reportId, kind } = req.params as {
        id: string;
        reportId: string;
        kind: string;
      };
      if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });
      if (await isSandboxCoop(id)) {
        return reply.code(404).send({ error: "regulator reports are unavailable for the sandbox" });
      }
      if (kind !== "xlsx" && kind !== "pdf" && kind !== "csv") {
        return reply.code(400).send({ error: "kind must be xlsx, pdf or csv" });
      }

      const report = await withCoopContext(id, () =>
        prisma.regulatorReport.findFirst({ where: { id: reportId, cooperativeId: id } }),
      );
      if (!report?.files) return reply.code(404).send({ error: "report not found" });

      let stored: string | undefined;
      if (typeof report.files === "string") {
        try {
          const parsed = JSON.parse(report.files) as Record<string, unknown> | null;
          const candidate = parsed?.[kind];
          stored = typeof candidate === "string" ? candidate : undefined;
        } catch {
          stored = undefined;
        }
      } else if (report.files && typeof report.files === "object") {
        const candidate = (report.files as Record<string, unknown>)[kind];
        stored = typeof candidate === "string" ? candidate : undefined;
      }
      if (!stored) return reply.code(404).send({ error: "file not found" });

      // Stored paths are relative to the export directory (e.g. `exports/x.xlsx`).
      // Resolve real paths (following symlinks) and reject anything outside that root.
      const root = resolve(process.cwd(), process.env.EXPORT_DIR ?? "exports");
      const absolute = resolve(process.cwd(), stored);
      let realRoot: string;
      let realFile: string;
      try {
        [realRoot, realFile] = await Promise.all([realpath(root), realpath(absolute)]);
      } catch {
        return reply.code(404).send({ error: "file not found" });
      }
      const rel = relative(realRoot, realFile);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return reply.code(404).send({ error: "file not found" });
      }

      try {
        const info = await stat(realFile);
        if (!info.isFile()) return reply.code(404).send({ error: "file not found" });
      } catch {
        return reply.code(404).send({ error: "file not found" });
      }

      const mime =
        kind === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : kind === "pdf"
            ? "application/pdf"
            : "text/csv";
      return reply
        .header("Content-Type", mime)
        .header("Content-Disposition", `attachment; filename="${basename(realFile)}"`)
        .send(createReadStream(realFile));
    },
  );

  app.post("/api/developer/coops/:id/regulator-reports/:reportId/file", async (req, reply) => {
    const { id, reportId } = req.params as { id: string; reportId: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });
    if (await isSandboxCoop(id)) {
      return reply.code(404).send({ error: "regulator reports are unavailable for the sandbox" });
    }

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

  // ---- Compliance registers (breaches, DPIAs, cross-border transfers) ----

  app.get("/api/developer/coops/:id/compliance-registers", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });
    const [breaches, dpias, crossBorderTransfers] = await Promise.all([
      listBreaches(id),
      listDpias(id),
      listCrossBorderTransfers(id),
    ]);
    return {
      breaches,
      breachSummary: summariseBreaches(breaches),
      dpias,
      crossBorderTransfers,
    };
  });

  app.post("/api/developer/coops/:id/breaches", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });
    try {
      return await createBreach(id, (req.body ?? {}) as BreachInput, actorOf(req));
    } catch (err) {
      if (err instanceof ComplianceRegisterError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.patch("/api/developer/coops/:id/breaches/:breachId", async (req, reply) => {
    const { id, breachId } = req.params as { id: string; breachId: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });
    try {
      return await updateBreach(id, breachId, (req.body ?? {}) as BreachPatch, actorOf(req));
    } catch (err) {
      if (err instanceof ComplianceRegisterError) {
        const notFound = err.message === "breach not found";
        return reply.code(notFound ? 404 : 400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post("/api/developer/coops/:id/dpias", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });
    try {
      return await createDpia(id, (req.body ?? {}) as DpiaInput, actorOf(req));
    } catch (err) {
      if (err instanceof ComplianceRegisterError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.patch("/api/developer/coops/:id/dpias/:dpiaId", async (req, reply) => {
    const { id, dpiaId } = req.params as { id: string; dpiaId: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });
    try {
      return await updateDpia(id, dpiaId, (req.body ?? {}) as DpiaInput, actorOf(req));
    } catch (err) {
      if (err instanceof ComplianceRegisterError) {
        const notFound = err.message === "DPIA not found";
        return reply.code(notFound ? 404 : 400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post("/api/developer/coops/:id/cross-border-transfers", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });
    try {
      return await createCrossBorderTransfer(
        id,
        (req.body ?? {}) as CrossBorderInput,
        actorOf(req),
      );
    } catch (err) {
      if (err instanceof ComplianceRegisterError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.patch("/api/developer/coops/:id/cross-border-transfers/:transferId", async (req, reply) => {
    const { id, transferId } = req.params as { id: string; transferId: string };
    if (!(await coopExists(id))) return reply.code(404).send({ error: "cooperative not found" });
    const body = (req.body ?? {}) as { status?: string };
    if (body.status !== "ended") {
      return reply.code(400).send({ error: "status must be ended" });
    }
    try {
      return await endCrossBorderTransfer(id, transferId, actorOf(req));
    } catch (err) {
      if (err instanceof ComplianceRegisterError) {
        const notFound = err.message === "cross-border transfer not found";
        return reply.code(notFound ? 404 : 400).send({ error: err.message });
      }
      throw err;
    }
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

  // ---- Developer operations ----

  app.get("/api/developer/sandbox", async (req, reply) => {
    try {
      return await getSandboxOverview();
    } catch (err) {
      req.log.error({ err }, "Could not load sandbox overview");
      return reply.code(503).send({ error: "Sandbox is unavailable; check its configuration" });
    }
  });

  app.get("/api/developer/sandbox/state", async (req, reply) => {
    const { personaId } = req.query as { personaId?: string };
    if (!personaId || !isSandboxPersonaId(personaId)) {
      return reply.code(400).send({ error: "A valid personaId is required" });
    }
    try {
      return await getSandboxState(personaId);
    } catch (err) {
      req.log.error({ err }, "Could not load sandbox state");
      return reply.code(503).send({ error: "Sandbox state is unavailable" });
    }
  });

  app.post("/api/developer/sandbox/message", async (req, reply) => {
    if (!requireSandboxWriter(req, reply)) return;
    const body = (req.body ?? {}) as {
      personaId?: unknown;
      text?: unknown;
      aiEnabled?: unknown;
    };
    if (typeof body.personaId !== "string" || !isSandboxPersonaId(body.personaId)) {
      return reply.code(400).send({ error: "A valid personaId is required" });
    }
    if (typeof body.text !== "string") {
      return reply.code(400).send({ error: "text is required" });
    }
    const text = body.text.trim();
    if (!text || text.length > 500) {
      return reply.code(400).send({ error: "text must be between 1 and 500 characters" });
    }
    if (body.aiEnabled !== undefined && typeof body.aiEnabled !== "boolean") {
      return reply.code(400).send({ error: "aiEnabled must be a boolean" });
    }

    const admin = req.platformAdmin!;
    const rateLimit = await checkRateLimit(`sandbox:rl:turn:${admin.id}`, 60, 60);
    if (!rateLimit.allowed) {
      return reply
        .code(429)
        .send({ error: "Sandbox turn limit reached", retryAfter: rateLimit.retryAfter });
    }
    try {
      return await runSandboxTurn({
        personaId: body.personaId,
        text,
        aiEnabled: body.aiEnabled !== false,
      });
    } catch (err) {
      if (err instanceof SandboxBusyError) {
        return reply.code(409).send({ error: err.message });
      }
      req.log.error({ err }, "Sandbox turn failed");
      return reply
        .code(503)
        .send({ error: "Sandbox turn failed; reset the sandbox and try again" });
    }
  });

  app.post("/api/developer/sandbox/reset", async (req, reply) => {
    if (!requireSandboxWriter(req, reply)) return;
    const admin = req.platformAdmin!;
    const rateLimit = await checkRateLimit(`sandbox:rl:reset:${admin.id}`, 10, 60);
    if (!rateLimit.allowed) {
      return reply
        .code(429)
        .send({ error: "Sandbox reset limit reached", retryAfter: rateLimit.retryAfter });
    }
    try {
      const result = await resetSandbox(actorOf(req));
      return { ok: true, deleted: result.deleted, personas: SANDBOX_PERSONAS.length };
    } catch (err) {
      if (err instanceof SandboxBusyError) {
        return reply.code(409).send({ error: err.message });
      }
      req.log.error({ err }, "Sandbox reset failed");
      return reply
        .code(503)
        .send({ error: "Sandbox reset failed; retry after checking server logs" });
    }
  });

  app.get("/api/developer/ops/liquidity", async () => {
    const ids = await listCooperativeIds();
    const coops = [];
    for (const id of ids) {
      const coopData = await withCoopContext(id, async () => {
        const coop = await prisma.cooperative.findUnique({
          where: { id },
          select: { isSandbox: true },
        });
        if (!coop || coop.isSandbox) return null;
        const stats = await coopStats(id);
        const loans = await prisma.loan.findMany({
          where: { cooperativeId: id, status: "disbursed", balance: { gt: 0 } },
          select: { balance: true, dueDate: true },
        });
        return { stats, loans };
      });
      if (coopData) coops.push(coopData);
    }

    const now = Date.now();
    const totalLoanOutstanding = coops.reduce((sum, { stats }) => sum + stats.loanOutstanding, 0);
    const atRisk30 = coops.reduce(
      (sum, { loans }) =>
        sum +
        loans.reduce(
          (loanSum, loan) =>
            loan.dueDate && loan.dueDate.getTime() <= now - 30 * 24 * 60 * 60 * 1000
              ? loanSum + loan.balance
              : loanSum,
          0,
        ),
      0,
    );
    const atRisk90 = coops.reduce(
      (sum, { loans }) =>
        sum +
        loans.reduce(
          (loanSum, loan) =>
            loan.dueDate && loan.dueDate.getTime() <= now - 90 * 24 * 60 * 60 * 1000
              ? loanSum + loan.balance
              : loanSum,
          0,
        ),
      0,
    );
    const totals = coops.reduce(
      (sum, { stats }) => ({
        memberCount: sum.memberCount + stats.memberCount,
        savingsTotal: sum.savingsTotal + stats.savingsTotal,
        loanOutstanding: sum.loanOutstanding + stats.loanOutstanding,
        pendingPayouts: sum.pendingPayouts + stats.pendingPayouts,
        pendingWithdrawals: sum.pendingWithdrawals + stats.pendingWithdrawals,
        reserveFundBalance: sum.reserveFundBalance + stats.reserveFundBalance,
        walletFloat: sum.walletFloat + stats.walletFloat,
      }),
      {
        memberCount: 0,
        savingsTotal: 0,
        loanOutstanding: 0,
        pendingPayouts: 0,
        pendingWithdrawals: 0,
        reserveFundBalance: 0,
        walletFloat: 0,
      },
    );

    return {
      totals: {
        cooperativeCount: coops.length,
        ...totals,
        pendingOutflows: totals.pendingPayouts + totals.pendingWithdrawals,
        par30Amount: atRisk30,
        par30Pct:
          totalLoanOutstanding > 0
            ? Math.round((atRisk30 / totalLoanOutstanding) * 10000) / 100
            : 0,
        par90Amount: atRisk90,
        par90Pct:
          totalLoanOutstanding > 0
            ? Math.round((atRisk90 / totalLoanOutstanding) * 10000) / 100
            : 0,
        reserveToSavingsPct:
          totals.savingsTotal > 0
            ? Math.round((totals.reserveFundBalance / totals.savingsTotal) * 10000) / 100
            : 0,
      },
      reserveTargetConfigured: false,
      coops: coops.map(({ stats }) => ({
        id: stats.id,
        name: stats.name,
        code: stats.code,
        status: stats.status,
        memberCount: stats.memberCount,
        savingsTotal: stats.savingsTotal,
        loanOutstanding: stats.loanOutstanding,
        pendingOutflows: stats.pendingPayouts + stats.pendingWithdrawals,
        reserveFundBalance: stats.reserveFundBalance,
      })),
      asOf: new Date().toISOString(),
    };
  });

  app.get("/api/developer/ops/jobs", async (req, reply) => {
    const redis = getRedis();
    if (!redis) {
      return {
        configured: isRedisConfigured(),
        connected: false,
        schedulers: [],
        recentRuns: [],
      };
    }

    const queue = new Queue(QUEUE_NAMES.SCHEDULER, { connection: redis });
    try {
      const [schedulers, completed, failed] = await Promise.all([
        queue.getJobSchedulers(0, 49, false),
        queue.getJobs(["completed"], 0, 9, false),
        queue.getJobs(["failed"], 0, 9, false),
      ]);
      const recentRuns = [...completed, ...failed]
        .map((job) => ({
          id: job.id,
          name: job.name,
          job: typeof job.data?.job === "string" ? job.data.job : job.name,
          cooperativeId:
            typeof job.data?.cooperativeId === "string" ? job.data.cooperativeId : null,
          status: failed.includes(job) ? "failed" : "completed",
          finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
          failedReason: failed.includes(job) ? "The worker reported a failed run" : null,
        }))
        .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))
        .slice(0, 12);

      return {
        configured: true,
        connected: true,
        schedulers: schedulers.map((scheduler) => ({
          id: scheduler.key,
          name: scheduler.name,
          everyMs: scheduler.every ?? null,
          pattern: scheduler.pattern ?? null,
          nextAt: scheduler.next ? new Date(scheduler.next).toISOString() : null,
        })),
        recentRuns,
        manualRun: {
          job: "loan_reminders",
          description: "Send due-loan reminders for one cooperative",
          scopeRequired: true,
          allowed: true,
        },
      };
    } catch (err) {
      req.log.error({ err }, "Could not read scheduler queue");
      return reply.code(503).send({ error: "Could not read scheduler status" });
    } finally {
      await queue.close();
    }
  });

  app.post("/api/developer/ops/jobs/run", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const body = (req.body ?? {}) as { job?: string; cooperativeId?: string };
    if (body.job !== "loan_reminders" || !body.cooperativeId) {
      return reply.code(400).send({
        error: "Only cooperative-scoped loan reminders can be run manually",
      });
    }
    if (!(await coopExists(body.cooperativeId))) {
      return reply.code(404).send({ error: "cooperative not found" });
    }
    if (await isSandboxCoop(body.cooperativeId)) {
      return reply
        .code(400)
        .send({ error: "sandbox cooperatives are excluded from scheduled jobs" });
    }
    const redis = getRedis();
    if (!redis) return reply.code(503).send({ error: "Redis queue is unavailable" });

    const actor = actorOf(req);
    const rateLimit = await checkRateLimit(`dev-job-run:${actor.id}`, 3, 60);
    if (!rateLimit.allowed) {
      return reply.code(429).send({
        error: "Manual job run limit reached; try again later",
        retryAfter: rateLimit.retryAfter,
      });
    }
    const queue = new Queue(QUEUE_NAMES.SCHEDULER, { connection: redis });
    try {
      const job = await queue.add(
        "manual-loan-reminders",
        { job: "loan_reminders", cooperativeId: body.cooperativeId },
        {
          ...DEFAULT_JOB_OPTIONS,
          jobId: `manual-loan-reminders-${body.cooperativeId}-${new Date().toISOString().slice(0, 10)}`,
        },
      );
      await writePlatformAudit({
        actorId: actor.id,
        actorPhone: actor.phone,
        actorRole: actor.role,
        action: "scheduler.run",
        cooperativeId: body.cooperativeId,
        targetType: "scheduler_job",
        targetId: "loan_reminders",
        detail: JSON.stringify({ jobId: job.id }),
      });
      return reply.code(202).send({ ok: true, jobId: job.id, status: "queued" });
    } catch (err) {
      req.log.error({ err }, "Could not enqueue manual scheduler run");
      return reply.code(503).send({ error: "Could not queue the scheduler run" });
    } finally {
      await queue.close();
    }
  });

  app.get("/api/developer/ops/webhooks", async (req) => {
    const { take } = req.query as { take?: string };
    const parsed = Number.parseInt(take ?? "", 10);
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50;
    const [inboundFailures, providerEvents] = await Promise.all([
      prisma.webhookFailure.findMany({
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { id: true, channel: true, messageId: true, error: true, createdAt: true },
      }),
      prisma.webhookEvent.findMany({
        orderBy: { receivedAt: "desc" },
        take: limit,
        select: {
          id: true,
          provider: true,
          kind: true,
          status: true,
          payloadHash: true,
          receivedAt: true,
          processedAt: true,
        },
      }),
    ]);
    return {
      events: [
        ...inboundFailures.map((event) => ({
          id: event.id,
          source: event.channel,
          kind: "inbound_failure",
          status: "failed",
          reference: event.messageId,
          receivedAt: event.createdAt,
          detail: event.error.slice(0, 240),
          canReplay: false,
        })),
        ...providerEvents.map((event) => ({
          id: event.id,
          source: event.provider,
          kind: event.kind ?? "provider_event",
          status: event.status,
          reference: event.id,
          receivedAt: event.receivedAt,
          processedAt: event.processedAt,
          payloadHash: event.payloadHash,
          detail: null,
          canReplay: false,
        })),
      ]
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
        .slice(0, limit),
      replayEnabled: false,
      replayDisabledReason:
        "The platform stores payload hashes and failure metadata, not replayable request bodies.",
    };
  });

  app.post("/api/developer/ops/diagnostics/check", async (req, reply) => {
    if (!requireOwner(req, reply)) return;
    const actor = actorOf(req);
    if (!(await checkRateLimit(`dev-diagnostics:${actor.id}`, 3, 60))) {
      return reply.code(429).send({ error: "Diagnostic check limit reached; try again later" });
    }

    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const groqKey = process.env.GROQ_API_KEY;
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;
    const flutterwaveKey = process.env.FLUTTERWAVE_SECRET_KEY;
    const monnifyKey = process.env.MONNIFY_API_KEY;
    const monnifySecret = process.env.MONNIFY_SECRET_KEY;

    const checks: Record<string, Promise<DiagnosticResult>> = {
      database: prisma.$queryRaw`SELECT 1`
        .then(() => ({ status: "healthy" as const, message: "Database query succeeded" }))
        .catch(() => ({ status: "error" as const, message: "Database query failed" })),
      redis: (async () => {
        if (!isRedisConfigured()) return missingDiagnostic();
        try {
          const redis = getRedis();
          if (!redis || (await redis.ping()) !== "PONG") {
            return { status: "error", message: "Redis did not answer PING" };
          }
          return { status: "healthy", message: "Redis answered PING" };
        } catch {
          return { status: "error", message: "Redis did not answer PING" };
        }
      })(),
      whatsapp:
        token && phoneNumberId
          ? probeExternalService(
              `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}?fields=id`,
              { headers: { Authorization: `Bearer ${token}` } },
            )
          : Promise.resolve(missingDiagnostic()),
      groq: groqKey
        ? probeExternalService("https://api.groq.com/openai/v1/models", {
            headers: { Authorization: `Bearer ${groqKey}` },
          })
        : Promise.resolve(missingDiagnostic()),
      paystack: paystackKey
        ? probeExternalService("https://api.paystack.co/balance", {
            headers: { Authorization: `Bearer ${paystackKey}` },
          })
        : Promise.resolve(missingDiagnostic()),
      flutterwave: flutterwaveKey
        ? probeExternalService("https://api.flutterwave.com/v3/balances/NGN", {
            headers: { Authorization: `Bearer ${flutterwaveKey}` },
          })
        : Promise.resolve(missingDiagnostic()),
      monnify:
        monnifyKey && monnifySecret
          ? (() => {
              const configuredBase = process.env.MONNIFY_BASE_URL ?? "https://sandbox.monnify.com";
              let host: string;
              try {
                const parsed = new URL(configuredBase);
                if (
                  parsed.protocol !== "https:" ||
                  !["api.monnify.com", "sandbox.monnify.com"].includes(parsed.hostname)
                ) {
                  return Promise.resolve({
                    status: "error",
                    message: "Monnify base URL is not an approved HTTPS host",
                  });
                }
                host = parsed.origin;
              } catch {
                return Promise.resolve({
                  status: "error",
                  message: "Monnify base URL is invalid",
                });
              }
              const authorization = Buffer.from(`${monnifyKey}:${monnifySecret}`).toString(
                "base64",
              );
              return probeExternalService(`${host}/api/v1/auth/login`, {
                method: "POST",
                headers: {
                  Authorization: `Basic ${authorization}`,
                  "Content-Type": "application/json",
                },
                body: "{}",
              });
            })()
          : Promise.resolve(missingDiagnostic()),
    };

    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => [name, await check] as const),
    );
    const results = Object.fromEntries(entries) as Record<string, DiagnosticResult>;
    await writePlatformAudit({
      actorId: actor.id,
      actorPhone: actor.phone,
      actorRole: actor.role,
      action: "diagnostics.check",
      targetType: "platform_integrations",
      targetId: "all",
      detail: JSON.stringify(
        Object.fromEntries(
          Object.entries(results).map(([name, result]) => [
            name,
            { status: result.status, statusCode: result.statusCode },
          ]),
        ),
      ),
    });
    return { checkedAt: new Date().toISOString(), results };
  });

  app.all("/api/developer/*", async (_req, reply) => {
    return reply.code(404).send({ error: "Not found" });
  });
}
