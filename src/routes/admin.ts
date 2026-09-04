import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { verifyPin } from "../lib/security.js";
import { checkRateLimit } from "../lib/cache.js";
import { recordSuspiciousEvent } from "../lib/security-hardening.js";
import { approveLoan } from "../services/loans.js";
import { notifyMember } from "../lib/messaging.js";
import { sign, revokeToken, isTokenRevoked, verifyAdminToken, requireLiveAdmin } from "../lib/admin-auth.js";

/**
 * Minimal admin auth for the dashboard: members log in with their WhatsApp
 * phone + 4-digit PIN. The dashboard calls /api/admin/login which returns a
 * short-lived token (phone signed with the server secret). All other routes
 * require `Authorization: Bearer <token>`.
 */

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

    // Reject suspended/deceased admins outright — they must not be able to
    // mint a token (defense against the export route and any future surface
    // that trusts the token alone). The preHandler's live re-check is the
    // authoritative gate; this closes the token-issuance path too.
    if (member.status === "suspended" || member.status === "deceased") {
      await recordSuspiciousEvent({
        memberId: member.id,
        cooperativeId: member.cooperativeId,
        memberPhone: phone,
        event: "admin_login_inactive",
        detail: `Inactive admin (${member.status}) login attempt from IP ${ip}`,
      });
      return reply.code(403).send({ error: "Account is not active" });
    }

    const token = sign(phone, member.cooperative.id, member.role);
    return {
      token,
      member: {
        id: member.id,
        name: member.name,
        phone: member.phone,
        role: member.role,
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
    const payload = rawToken ? verifyAdminToken(rawToken) : null;
    if (!payload) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    if (rawToken && await isTokenRevoked(rawToken)) {
      return reply.code(401).send({ error: "token revoked" });
    }

    // Re-check the member's CURRENT role/status from the DB (fail-closed) so
    // a demoted, suspended, or deceased admin loses dashboard access
    // immediately (not at token expiry). The live read re-derives the phone,
    // role, AND cooperativeId from the DB row rather than trusting the
    // self-contained, possibly-stale token claims.
    const live = await requireLiveAdmin(payload);
    if (!live) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    req.adminPhone = live.phone;
    req.adminCoopId = live.cooperativeId;
    req.adminRole = live.role;
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
    });
    if (!actor) return reply.code(401).send({ error: "actor not found" });

    // Superadmin is role-based only — no adminPhone alias override (matches chat path).
    const isSuper = actor.role === "superadmin";

    const loan = await prisma.loan.findFirst({ where: { id, cooperativeId: coopId } });
    if (!loan) return reply.code(404).send({ error: "loan not found in your cooperative" });

    const result = await approveLoan(id, { superAdmin: isSuper, actorId: actor.id, cooperativeId: coopId });
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

  // ---- Grievances (member complaints) ----

  app.get("/api/admin/grievances", async (req) => {
    const coopId = req.adminCoopId!;
    return prisma.grievance.findMany({
      where: { cooperativeId: coopId },
      include: {
        member: { select: { name: true, phone: true, code: true } },
        resolvedBy: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });

  app.post("/api/admin/grievances/:id/resolve", async (req, reply) => {
    const coopId = req.adminCoopId!;
    const phone = req.adminPhone!;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { response?: string };
    const response = String(body.response ?? "").trim();
    if (!response) return reply.code(400).send({ error: "A response message is required" });

    const actor = await prisma.member.findFirst({ where: { phone, cooperativeId: coopId } });
    if (!actor) return reply.code(401).send({ error: "actor not found" });

    const grievance = await prisma.grievance.findFirst({ where: { id, cooperativeId: coopId }, include: { member: true } });
    if (!grievance) return reply.code(404).send({ error: "Grievance not found" });
    if (grievance.status === "resolved") return reply.code(400).send({ error: "Grievance is already resolved" });

    await prisma.grievance.update({
      where: { id: grievance.id },
      data: {
        status: "resolved",
        response: response.slice(0, 500),
        resolvedById: actor.id,
        resolvedAt: new Date(),
      },
    });

    await notifyMember(
      grievance.member,
      `✅ Your grievance *${grievance.id.slice(-6)}* has been resolved.\n\nResponse: ${response}`,
    ).catch(() => {});

    await prisma.auditLog.create({
      data: {
        cooperativeId: coopId,
        actorId: actor.id,
        actorPhone: phone,
        actorRole: actor.role,
        action: "grievance.resolve",
        targetType: "grievance",
        targetId: grievance.id,
        detail: `Resolved grievance from ${grievance.member.name}`,
      },
    });

    return { ok: true, message: `Grievance *${grievance.id.slice(-6)}* resolved. ${grievance.member.name} notified.` };
  });

  // ---- Support Tickets ----

  app.get("/api/admin/tickets", async (req) => {
    const coopId = req.adminCoopId!;
    const status = (req.query as { status?: string }).status;
    return prisma.supportTicket.findMany({
      where: { cooperativeId: coopId, ...(status ? { status } : {}) },
      include: {
        member: { select: { name: true, phone: true, code: true } },
        assignedTo: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });

  app.post("/api/admin/tickets/:id/resolve", async (req, reply) => {
    const coopId = req.adminCoopId!;
    const phone = req.adminPhone!;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { note?: string };
    const note = String(body.note ?? "").trim();

    const actor = await prisma.member.findFirst({ where: { phone, cooperativeId: coopId } });
    if (!actor) return reply.code(401).send({ error: "actor not found" });

    const ticket = await prisma.supportTicket.findFirst({ where: { id, cooperativeId: coopId }, include: { member: true } });
    if (!ticket) return reply.code(404).send({ error: "Ticket not found" });
    if (ticket.status === "resolved") return reply.code(400).send({ error: "Ticket is already resolved" });

    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: "resolved",
        assignedToId: actor.id,
        resolution: note.slice(0, 500) || null,
        resolvedAt: new Date(),
        firstResponseAt: ticket.firstResponseAt ?? new Date(),
      },
    });

    await notifyMember(
      ticket.member,
      `✅ Your ticket *${ticket.id.slice(-6)}* has been resolved.\n${note ? `Note: ${note}` : ""}`,
    ).catch(() => {});

    await prisma.auditLog.create({
      data: {
        cooperativeId: coopId,
        actorId: actor.id,
        actorPhone: phone,
        actorRole: actor.role,
        action: "ticket.resolve",
        targetType: "ticket",
        targetId: ticket.id,
        detail: `Resolved ticket from ${ticket.member.name}`,
      },
    });

    return { ok: true, message: `Ticket *${ticket.id.slice(-6)}* resolved. ${ticket.member.name} notified.` };
  });

  // ---- Executive Posts (organogram) ----

  app.get("/api/admin/posts", async (req) => {
    const coopId = req.adminCoopId!;
    return prisma.coopPost.findMany({
      where: { cooperativeId: coopId },
      include: {
        incumbent: { select: { name: true, phone: true, code: true } },
      },
      orderBy: { title: "asc" },
    });
  });

  app.post("/api/admin/posts", async (req, reply) => {
    const superAuth = await requireSuper(req);
    if (!superAuth.ok) return reply.code(403).send({ error: "Only the super admin can create posts." });
    const coopId = req.adminCoopId!;
    const phone = req.adminPhone!;
    const body = (req.body ?? {}) as { title?: string };
    if (!body.title) return reply.code(400).send({ error: "Post title is required" });

    const { normalizeTitle } = await import("../services/posts.js");
    const title = normalizeTitle(String(body.title));
    const existing = await prisma.coopPost.findFirst({ where: { cooperativeId: coopId, title } });
    if (existing) return reply.code(400).send({ error: "A post with this title already exists" });

    const post = await prisma.coopPost.create({
      data: {
        cooperativeId: coopId,
        title,
        appointedById: superAuth.actorId,
        appointedAt: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        cooperativeId: coopId,
        actorId: superAuth.actorId,
        actorPhone: phone,
        actorRole: "superadmin",
        action: "post.create",
        targetType: "post",
        targetId: post.id,
        detail: `Created post "${normalizeTitle(title)}"`,
      },
    });

    return { ok: true, message: `Post "${normalizeTitle(title)}" created.` };
  });

  app.post("/api/admin/posts/:id/assign", async (req, reply) => {
    const superAuth = await requireSuper(req);
    if (!superAuth.ok) return reply.code(403).send({ error: "Only the super admin can assign posts." });
    const coopId = req.adminCoopId!;
    const phone = req.adminPhone!;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { memberCode?: string };

    const post = await prisma.coopPost.findFirst({ where: { id, cooperativeId: coopId } });
    if (!post) return reply.code(404).send({ error: "Post not found" });

    let incumbentId: string | null = null;
    let memberName = "_vacant_";
    if (body.memberCode) {
      const member = await prisma.member.findFirst({ where: { code: body.memberCode, cooperativeId: coopId } });
      if (!member) return reply.code(400).send({ error: `Member code ${body.memberCode} not found` });
      incumbentId = member.id;
      memberName = member.name;
    }

    await prisma.coopPost.update({
      where: { id: post.id },
      data: { incumbentId, appointedById: superAuth.actorId, appointedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        cooperativeId: coopId,
        actorId: superAuth.actorId,
        actorPhone: phone,
        actorRole: "superadmin",
        action: "post.assign",
        targetType: "post",
        targetId: post.id,
        detail: `${body.memberCode ? `Assigned "${post.title}" to ${memberName}` : `Vacated "${post.title}"`}`,
      },
    });

    return { ok: true, message: body.memberCode ? `"${post.title}" assigned to ${memberName}.` : `"${post.title}" is now vacant.` };
  });

  // ---- Payroll ----

  app.get("/api/admin/payroll", async (req) => {
    const coopId = req.adminCoopId!;
    const { payrollOverview } = await import("../services/payroll.js");
    return { participants: await payrollOverview(coopId) };
  });

  app.post("/api/admin/payroll/set", async (req, reply) => {
    const superAuth = await requireSuper(req);
    if (!superAuth.ok) return reply.code(403).send({ error: "Only the super admin can set salaries." });
    const coopId = req.adminCoopId!;
    const body = (req.body ?? {}) as { memberCode?: string; amount?: number | "off" };
    if (!body.memberCode) return reply.code(400).send({ error: "memberCode is required" });

    const actor = await prisma.member.findFirst({ where: { id: superAuth.actorId, cooperativeId: coopId } });
    if (!actor) return reply.code(401).send({ error: "actor not found" });

    const target = await prisma.member.findFirst({ where: { code: body.memberCode, cooperativeId: coopId } });
    if (!target) return reply.code(400).send({ error: `Member code ${body.memberCode} not found` });

    const { setSalary } = await import("../services/payroll.js");
    const result = await setSalary(actor, target.phone, body.amount === "off" ? "off" : Number(body.amount));
    if (!result.ok) return reply.code(400).send({ error: result.message });
    return { ok: true, message: result.message };
  });

  app.post("/api/admin/payroll/run", async (req, reply) => {
    const superAuth = await requireSuper(req);
    if (!superAuth.ok) return reply.code(403).send({ error: "Only the super admin can run payroll." });
    const coopId = req.adminCoopId!;
    const actor = await prisma.member.findFirst({ where: { id: superAuth.actorId, cooperativeId: coopId } });
    if (!actor) return reply.code(401).send({ error: "actor not found" });

    const body = (req.body ?? {}) as { narration?: string };
    const narration = String(body.narration ?? "").trim();
    if (!narration) return reply.code(400).send({ error: "A narration is required" });

    const { runPayroll } = await import("../services/payroll.js");
    const result = await runPayroll(coopId, { id: actor.id, phone: actor.phone, role: actor.role }, narration);
    return { ok: result.ok, message: result.message, paid: result.paid ?? 0, total: result.total ?? 0 };
  });

  app.get("/api/admin/payroll/history", async (req) => {
    const coopId = req.adminCoopId!;
    const [paye, ledger] = await Promise.all([
      prisma.pAYERecord.findMany({
        where: { cooperativeId: coopId },
        include: { member: { select: { name: true, code: true } } },
        orderBy: [{ year: "desc" }, { month: "desc" }],
        take: 200,
      }),
      prisma.ledgerEntry.findMany({
        where: { cooperativeId: coopId, category: { in: ["salary", "stipend"] } },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ]);
    return { paye, ledger };
  });

  // ---- Reserves / Funds ----

  app.get("/api/admin/funds", async (req) => {
    const coopId = req.adminCoopId!;
    const [coop, reserve, education, development] = await Promise.all([
      prisma.cooperative.findUnique({ where: { id: coopId }, select: { reserveFundBalance: true } }),
      prisma.reserveAllocation.findMany({
        where: { cooperativeId: coopId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.educationFund.findMany({
        where: { cooperativeId: coopId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.developmentFund.findMany({
        where: { cooperativeId: coopId },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);
    const sum = (rows: { amount: number }[]) => rows.reduce((a, r) => a + r.amount, 0);
    return {
      reserveBalance: coop?.reserveFundBalance ?? 0,
      educationBalance: sum(education),
      developmentBalance: sum(development),
      allocations: reserve,
      education: education,
      development: development,
    };
  });

  // ---- Elections (management) ----

  app.get("/api/admin/votes", async (req) => {
    const coopId = req.adminCoopId!;
    return prisma.vote.findMany({
      where: { cooperativeId: coopId },
      include: {
        candidates: {
          include: {
            member: { select: { name: true, code: true } },
            _count: { select: { ballots: true } },
          },
        },
        _count: { select: { ballots: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  });

  async function requireSuper(req: { adminCoopId?: string; adminPhone?: string }): Promise<{ ok: boolean; actorId?: string; phone?: string }> {
    const coopId = req.adminCoopId;
    const phone = req.adminPhone;
    if (!coopId || !phone) return { ok: false };
    const actor = await prisma.member.findFirst({ where: { phone, cooperativeId: coopId } });
    if (!actor || actor.role !== "superadmin") return { ok: false };
    return { ok: true, actorId: actor.id, phone };
  }

  app.post("/api/admin/funds/reserve/allocate", async (req, reply) => {
    const superAuth = await requireSuper(req);
    if (!superAuth.ok) return reply.code(403).send({ error: "Only the super admin can allocate to the reserve fund." });
    const coopId = req.adminCoopId!;
    const phone = req.adminPhone!;
    const body = (req.body ?? {}) as { amount?: number; note?: string };
    const amount = Math.round(Number(body.amount ?? 0));
    if (!(amount > 0)) return reply.code(400).send({ error: "A valid amount is required (in kobo)" });
    const note = String(body.note ?? "").trim().slice(0, 200) || null;

    const coop = await prisma.cooperative.findUnique({ where: { id: coopId } });
    if (!coop) return reply.code(404).send({ error: "Cooperative not found" });

    await prisma.cooperative.update({
      where: { id: coopId },
      data: { reserveFundBalance: coop.reserveFundBalance + amount },
    });
    await prisma.reserveAllocation.create({
      data: {
        cooperativeId: coopId,
        amount,
        source: "manual",
        note,
      },
    });

    await prisma.auditLog.create({
      data: {
        cooperativeId: coopId,
        actorId: superAuth.actorId,
        actorPhone: phone,
        actorRole: "superadmin",
        action: "funds.reserve.allocate",
        targetType: "cooperative",
        amount,
        detail: `Manual reserve allocation of ${amount} kobo${note ? " — " + note : ""}`,
      },
    });

    return { ok: true, message: "Reserve fund allocation recorded and balance updated." };
  });

  // ---- Elections (management) ----

  app.post("/api/admin/votes/start", async (req, reply) => {
    const superAuth = await requireSuper(req);
    if (!superAuth.ok) return reply.code(403).send({ error: "Only the super admin can start an election." });
    const body = (req.body ?? {}) as { kind?: string; scope?: string; title?: string };
    const { startVote } = await import("../services/votes.js");
    const result = await startVote(superAuth.phone!, body.kind ?? "", body.scope, body.title ?? "");
    if (!result.ok) return reply.code(400).send({ error: result.message });
    return { ok: true, message: result.message, voteId: result.voteId };
  });

  app.post("/api/admin/votes/:id/candidate", async (req, reply) => {
    const superAuth = await requireSuper(req);
    if (!superAuth.ok) return reply.code(403).send({ error: "Only the super admin can add candidates." });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { memberCode?: string };
    if (!body.memberCode) return reply.code(400).send({ error: "memberCode is required" });
    const { addCandidate } = await import("../services/votes.js");
    const result = await addCandidate(superAuth.phone!, id, body.memberCode);
    if (!result.ok) return reply.code(400).send({ error: result.message });
    return { ok: true, message: result.message };
  });

  app.post("/api/admin/votes/:id/close", async (req, reply) => {
    const superAuth = await requireSuper(req);
    if (!superAuth.ok) return reply.code(403).send({ error: "Only the super admin can close an election." });
    const { id } = req.params as { id: string };
    const { closeVote } = await import("../services/votes.js");
    const result = await closeVote(superAuth.phone!, id);
    if (!result.ok) return reply.code(400).send({ error: result.message });
    return { ok: true, message: result.message };
  });

  app.get("/api/admin/votes/:id/results", async (req, reply) => {
    const coopId = req.adminCoopId!;
    const phone = req.adminPhone!;
    const { id } = req.params as { id: string };
    const vote = await prisma.vote.findFirst({ where: { id, cooperativeId: coopId }, select: { id: true } });
    if (!vote) return reply.code(404).send({ error: "Election not found" });
    const { showLiveResults } = await import("../services/votes.js");
    const result = await showLiveResults(phone, id);
    if (!result.ok) return reply.code(400).send({ error: result.message });
    return { ok: true, results: result.message };
  });

  app.post("/api/admin/votes/:id/export-pdf", async (req, reply) => {
    const superAuth = await requireSuper(req);
    if (!superAuth.ok) return reply.code(403).send({ error: "Only the super admin can export results." });
    const coopId = req.adminCoopId!;
    const { id } = req.params as { id: string };
    const { exportElectionPdf } = await import("../services/election-export.js");
    const result = await exportElectionPdf(coopId, id);
    if (!result.ok) return reply.code(400).send({ error: result.message });
    return { ok: true, message: result.message, files: result.file ? [result.file] : [] };
  });
}