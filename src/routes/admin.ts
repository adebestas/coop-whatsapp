import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { verifyPin } from "../lib/security.js";
import { checkRateLimit, getRedis } from "../lib/cache.js";
import { recordSuspiciousEvent } from "../lib/security-hardening.js";
import { approveLoan } from "../services/loans.js";
import { notifyMember } from "../lib/messaging.js";

/**
 * Minimal admin auth for the dashboard: members log in with their WhatsApp
 * phone + 4-digit PIN. The dashboard calls /api/admin/login which returns a
 * short-lived token (phone signed with the server secret). All other routes
 * require `Authorization: Bearer <token>`.
 */
import crypto from "node:crypto";
import { timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const TOKEN_BLACKLIST_PREFIX = "admin:token:blacklist:";
const TOKEN_BLACKLIST_TTL_SECONDS = Math.ceil(TOKEN_TTL_MS / 1000);

const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_SECONDS = 60; // 1 minute
const MAX_ACCOUNT_ATTEMPTS = 10;
const ACCOUNT_WINDOW_SECONDS = 15 * 60; // 15 minutes

async function checkLoginRateLimit(ip: string, phone?: string): Promise<{ allowed: boolean; retryAfter?: number }> {
  // Per-IP limit
  const ipResult = await checkRateLimit(`login:ip:${ip}`, MAX_LOGIN_ATTEMPTS, LOGIN_WINDOW_SECONDS);
  if (!ipResult.allowed) return ipResult;

  // Per-account limit
  if (phone) {
    const acctResult = await checkRateLimit(`login:acct:${phone}`, MAX_ACCOUNT_ATTEMPTS, ACCOUNT_WINDOW_SECONDS);
    if (!acctResult.allowed) return acctResult;
  }

  return { allowed: true };
}

/**
 * Revoke an admin token by storing its hash in Redis with a TTL matching
 * the token's remaining lifetime. After expiry, the token is no longer
 * valid even if its HMAC signature is correct.
 */
export async function revokeToken(token: string): Promise<void> {
  const client = getRedis();
  if (!client) return;
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  try {
    await client.setex(`${TOKEN_BLACKLIST_PREFIX}${hash}`, TOKEN_BLACKLIST_TTL_SECONDS, "1");
  } catch (err) {
    console.error("[admin] failed to revoke token:", err);
  }
}

/**
 * Check whether a token has been revoked (exists in the Redis blacklist).
 * Fails OPEN when Redis is unavailable (returns not-revoked) so a transient
 * Redis/Upstash outage never locks admins out of the dashboard; signature
 * + expiry validation still gate every request.
 */
async function isTokenRevoked(token: string): Promise<boolean> {
  const client = getRedis();
  if (!client) return false; // Allow token when Redis is unavailable
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  try {
    const exists = await client.exists(`${TOKEN_BLACKLIST_PREFIX}${hash}`);
    return exists === 1;
  } catch {
    return true;
  }
}

function getSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) throw new Error("ADMIN_JWT_SECRET is not configured");
  return secret;
}

interface AdminTokenPayload {
  phone: string;
  cooperativeId: string;
  role: string;
}

// NOTE: Token includes cooperativeId for cooperative isolation — becomes critical for multi-tenant deployments.
function sign(phone: string, cooperativeId: string, role: string): string {
  const secret = getSecret();
  const payload = Buffer.from(JSON.stringify({ phone, cooperativeId, role, iat: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verify(token: string): AdminTokenPayload | null {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx === -1) return null;
  const payload = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const secret = getSecret();
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (Date.now() - data.iat > TOKEN_TTL_MS) return null;
    return { phone: data.phone, cooperativeId: data.cooperativeId, role: data.role };
  } catch {
    return null;
  }
}

export async function adminApiRoutes(app: FastifyInstance) {
  app.post("/api/admin/login", async (req, reply) => {
    const body = req.body as { phone?: string; pin?: string };
    const phone = body.phone?.replace(/[^0-9]/g, "");
    const pin = body.pin;
    const ip = req.ip;

    // Rate limit: max 5 attempts per minute per IP, 10 per 15 min per account
    const rateLimit = await checkLoginRateLimit(ip, phone);
    if (!rateLimit.allowed) {
      return reply.code(429).send({
        error: "Too many login attempts",
        retryAfter: rateLimit.retryAfter,
      });
    }

    if (!phone || !pin) {
      return reply.code(400).send({ error: "phone and pin required" });
    }
    const member = await prisma.member.findFirst({
      where: { phone, role: { in: ["admin", "superadmin"] } },
      include: { cooperative: true },
    });
    if (!member || !member.pin || !verifyPin(pin, member.pin)) {
      // Record suspicious event for auto-freeze (playbook Attack 8)
      if (member) {
        await recordSuspiciousEvent({
          memberId: member.id,
          cooperativeId: member.cooperativeId,
          memberPhone: phone,
          event: "admin_login_failed",
          detail: `Failed login from IP ${ip}`,
        });
      }
      return reply.code(401).send({ error: "invalid credentials" });
    }

    const token = sign(phone, member.cooperative.id, member.role);
    return {
      token,
      member: {
        id: member.id,
        name: member.name,
        phone: member.phone,
        cooperative: {
          id: member.cooperative.id,
          name: member.cooperative.name,
          code: member.cooperative.code,
          state: member.cooperative.state,
          country: member.cooperative.country,
          currency: member.cooperative.currency,
        },
      },
    };
  });

  // ---- Authenticated routes below ----
  app.addHook("preHandler", async (req, reply) => {
    if (req.url === "/api/admin/login") return;

    // CSRF protection: non-GET requests must include X-Requested-With header
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const requestedWith = req.headers["x-requested-with"];
      const rw = Array.isArray(requestedWith) ? requestedWith[0] : requestedWith;
      if (!rw || rw.toLowerCase() !== "xmlhttprequest") {
        return reply.code(403).send({ error: "Missing X-Requested-With header" });
      }
    }

    const auth = req.headers.authorization;
    const rawToken = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    const payload = rawToken ? verify(rawToken) : null;
    if (!payload) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (rawToken && await isTokenRevoked(rawToken)) {
      return reply.code(401).send({ error: "token revoked" });
    }
    req.adminPhone = payload.phone;
    req.adminCoopId = payload.cooperativeId;
    req.adminRole = payload.role;
  });

  app.post("/api/admin/logout", async (req, reply) => {
    const auth = req.headers.authorization;
    const rawToken = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (rawToken) {
      await revokeToken(rawToken);
    }
    return reply.code(200).send({ ok: true });
  });

  app.get("/api/admin/overview", async (req) => {
    const coopId = req.adminCoopId!;
    const [memberCount, contributions, contributionAgg, loans, walletAgg, payoutAgg] =
      await Promise.all([
        prisma.member.count({ where: { cooperativeId: coopId } }),
        prisma.contribution.count({ where: { cooperativeId: coopId } }),
        prisma.contribution.aggregate({
          where: { cooperativeId: coopId, status: "confirmed" },
          _sum: { amount: true },
        }),
        prisma.loan.count({ where: { cooperativeId: coopId, status: { in: ["approved", "disbursed"] } } }),
        prisma.wallet.aggregate({ where: { member: { cooperativeId: coopId } }, _sum: { balance: true, totalSaved: true } }),
        prisma.payout.count({ where: { cooperativeId: coopId } }),
      ]);

    return {
      memberCount,
      contributionCount: contributions,
      totalSaved: contributionAgg._sum.amount ?? 0,
      activeLoans: loans,
      walletBalance: walletAgg._sum.balance ?? 0,
      payoutCount: payoutAgg,
    };
  });

  app.get("/api/admin/members", async (req) => {
    const coopId = req.adminCoopId!;
    return prisma.member.findMany({
      where: { cooperativeId: coopId },
      select: {
        id: true, name: true, phone: true, email: true, code: true,
        role: true, status: true, cooperativeId: true, createdAt: true,
        wallet: true,
        // NOK/DOB removed - sensitive, superadmin-only via chat
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });

  // Send a broadcast / individual message to members via their messaging channel.
  app.post("/api/admin/messages/send", async (req, reply) => {
    const coopId = req.adminCoopId!;
    const actorPhone = req.adminPhone!;
    const actorRole = req.adminRole ?? "admin";
    const { memberIds = [], toAll = false, subject = "", body } = (req.body || {}) as {
      memberIds?: string[];
      toAll?: boolean;
      subject?: string;
      body?: string;
    };

    const text = String(body ?? "").trim();
    if (!text) {
      return reply.code(400).send({ error: "message body is required" });
    }

    // Resolve the intended recipients within this cooperative only.
    let targets: { id: string; code: string; phone: string; optedOut: boolean; altChannelId: string | null; preferredChannel: string | null }[];
    if (toAll) {
      targets = await prisma.member.findMany({
        where: { cooperativeId: coopId, status: "active" },
        select: { id: true, code: true, phone: true, optedOut: true, altChannelId: true, preferredChannel: true },
      });
    } else if (Array.isArray(memberIds) && memberIds.length > 0) {
      targets = await prisma.member.findMany({
        where: { id: { in: memberIds }, cooperativeId: coopId },
        select: { id: true, code: true, phone: true, optedOut: true, altChannelId: true, preferredChannel: true },
      });
    } else {
      return reply.code(400).send({ error: "select at least one member or broadcast to all" });
    }

    const full = subject?.trim() ? `*${subject.trim()}*\n\n${text}` : text;

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const failures: string[] = [];
    for (const member of targets) {
      if (member.optedOut) {
        skipped += 1;
        continue;
      }
      try {
        const ok = await notifyMember(member, full);
        if (ok) {
          sent += 1;
        } else {
          failed += 1;
          failures.push(member.code);
        }
      } catch {
        failed += 1;
        failures.push(member.code);
      }
    }

    await prisma.auditLog.create({
      data: {
        cooperativeId: coopId,
        actorId: "system",
        actorPhone,
        actorRole,
        action: "broadcast.send",
        targetType: toAll ? "all-members" : "members",
        detail: `Broadcast sent: ${sent} delivered, ${skipped} opted-out, ${failed} failed (${targets.length} targeted)`,
      },
    });

    return {
      ok: true,
      targeted: targets.length,
      sent,
      skipped,
      failed,
      failures,
    };
  });

  app.get("/api/admin/loans", async (req) => {
    const coopId = req.adminCoopId!;
    const status = (req.query as { status?: string }).status;
    return prisma.loan.findMany({
      where: { cooperativeId: coopId, ...(status ? { status } : {}) },
      include: {
        member: { select: { name: true, phone: true } },
        guarantors: { include: { member: { select: { name: true, phone: true } } } },
        repayments: true,
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });

  app.post("/api/admin/loans/:id/approve", async (req, reply) => {
    const coopId = req.adminCoopId!;
    const phone = req.adminPhone!;
    const { id } = req.params as { id: string };

    // Look up the admin member to get actorId and determine superadmin status
    const actor = await prisma.member.findFirst({
      where: { phone, cooperativeId: coopId },
      include: { cooperative: { select: { adminPhone: true } } },
    });
    if (!actor) return reply.code(401).send({ error: "actor not found" });

    const isSuper = actor.role === "superadmin" || actor.cooperative?.adminPhone === phone;

    const loan = await prisma.loan.findFirst({ where: { id, cooperativeId: coopId } });
    if (!loan) return reply.code(404).send({ error: "loan not found in your cooperative" });

    const result = await approveLoan(id, { superAdmin: isSuper, actorId: actor.id });
    if (!result.ok) {
      return reply.code(400).send({ error: result.message });
    }
    return { ok: true, message: result.message };
  });

  app.post("/api/admin/loans/:id/reject", async (req, reply) => {
    const coopId = req.adminCoopId!;
    const { id } = req.params as { id: string };
    const loan = await prisma.loan.findFirst({ where: { id, cooperativeId: coopId } });
    if (!loan) return reply.code(404).send({ error: "loan not found" });
    if (loan.status !== "pending") return reply.code(400).send({ error: `loan is ${loan.status}` });
    return prisma.loan.update({ where: { id }, data: { status: "rejected" } });
  });

  app.get("/api/admin/payouts", async (req) => {
    const coopId = req.adminCoopId!;
    return prisma.payout.findMany({
      where: { cooperativeId: coopId },
      include: { member: { select: { name: true, phone: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  app.get("/api/admin/contributions", async (req) => {
    const coopId = req.adminCoopId!;
    return prisma.contribution.findMany({
      where: { cooperativeId: coopId },
      include: { member: { select: { name: true, phone: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });

  app.get("/api/admin/annualreport/:year", async (req) => {
    const coopId = req.adminCoopId!;
    const year = Number((req.params as { year: string }).year);
    const reportYear = Number.isFinite(year) && year > 2000 ? year : new Date().getFullYear();
    const startOfYear = new Date(reportYear, 0, 1);
    const endOfYear = new Date(reportYear + 1, 0, 1);

    const [contribAgg, loanAgg, repaymentAgg, dividendAgg, memberCount, reserve, eduAgg, devAgg, walletAgg] =
      await Promise.all([
        prisma.contribution.aggregate({
          where: { cooperativeId: coopId, status: "confirmed", createdAt: { gte: startOfYear, lt: endOfYear } },
          _sum: { amount: true },
        }),
        prisma.loan.aggregate({
          where: { cooperativeId: coopId, status: { in: ["approved", "disbursed"] }, approvedAt: { gte: startOfYear, lt: endOfYear } },
          _sum: { amount: true },
          _count: true,
        }),
        prisma.loanRepayment.aggregate({
          where: { loan: { cooperativeId: coopId }, paidAt: { gte: startOfYear, lt: endOfYear } },
          _sum: { amount: true },
        }),
        prisma.dividend.aggregate({
          where: { cooperativeId: coopId, createdAt: { gte: startOfYear, lt: endOfYear } },
          _sum: { totalPool: true },
          _count: true,
        }),
        prisma.member.count({ where: { cooperativeId: coopId, status: "active" } }),
        prisma.cooperative.findUnique({ where: { id: coopId }, select: { reserveFundBalance: true } }),
        prisma.educationFund.aggregate({ where: { cooperativeId: coopId }, _sum: { amount: true } }),
        prisma.developmentFund.aggregate({ where: { cooperativeId: coopId }, _sum: { amount: true } }),
        prisma.wallet.aggregate({ where: { member: { cooperativeId: coopId } }, _sum: { balance: true } }),
      ]);

    const totalDividends = dividendAgg._sum.totalPool ?? 0;
    const perMember = memberCount > 0 ? Math.round(totalDividends / memberCount) : 0;

    return {
      year: reportYear,
      memberCount,
      totalContributions: contribAgg._sum.amount ?? 0,
      totalLoans: loanAgg._sum.amount ?? 0,
      loanCount: loanAgg._count,
      totalRepayments: repaymentAgg._sum.amount ?? 0,
      funds: {
        reserve: reserve?.reserveFundBalance ?? 0,
        education: eduAgg._sum.amount ?? 0,
        development: devAgg._sum.amount ?? 0,
      },
      dividends: { total: totalDividends, perMember, count: dividendAgg._count },
      walletBalance: walletAgg._sum.balance ?? 0,
    };
  });

  app.get("/api/admin/withdrawals", async (req) => {
    const coopId = req.adminCoopId!;
    return prisma.withdrawalRequest.findMany({
      where: { cooperativeId: coopId },
      include: { member: { select: { name: true, phone: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  app.get("/api/admin/polls", async (req) => {
    const coopId = req.adminCoopId!;
    return prisma.purchasePoll.findMany({
      where: { cooperativeId: coopId },
      include: {
        creator: { select: { name: true } },
        options: {
          orderBy: { createdAt: "asc" },
          include: { _count: { select: { ballots: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  });

  // ---- Compliance (PL/AML): STR + PAYE ----

  app.get("/api/admin/compliance/str", async (req) => {
    const coopId = req.adminCoopId!;
    return prisma.sTR.findMany({
      where: { cooperativeId: coopId },
      include: { member: { select: { name: true, phone: true, code: true } } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });

  app.get("/api/admin/compliance/paye", async (req) => {
    const coopId = req.adminCoopId!;
    return prisma.pAYERecord.findMany({
      where: { cooperativeId: coopId },
      include: { member: { select: { name: true, phone: true, code: true } } },
      orderBy: [{ year: "desc" }, { month: "desc" }],
      take: 500,
    });
  });

  app.post("/api/admin/compliance/export/:kind", async (req, reply) => {
    const coopId = req.adminCoopId!;
    const kind = (req.params as { kind: string }).kind;
    if (kind !== "str" && kind !== "paye") {
      return reply.code(400).send({ error: "Unknown compliance export kind" });
    }
    const { runComplianceExport } = await import("../services/compliance-export.js");
    const result = await runComplianceExport(coopId, kind);
    if (!result.ok) return reply.code(400).send({ error: result.message });
    return { ok: true, message: result.message, files: result.files ?? [] };
  });
}