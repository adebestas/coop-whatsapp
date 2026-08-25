import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { verifyPin } from "../lib/security.js";
import { checkRateLimit } from "../lib/cache.js";

/**
 * Minimal admin auth for the dashboard: members log in with their WhatsApp
 * phone + 4-digit PIN. The dashboard calls /api/admin/login which returns a
 * short-lived token (phone signed with the server secret). All other routes
 * require `Authorization: Bearer <token>`.
 */
import crypto from "node:crypto";
import { timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

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

function sign(phone: string, cooperativeId: string, role: string): string {
  const secret = getSecret();
  const payload = `${phone}.${cooperativeId}.${role}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verify(token: string): AdminTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const secret = getSecret();
  const payload = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(parts[3]))) return null;
  } catch {
    return null;
  }
  const issuedAt = Number(parts[3]);
  if (Date.now() - issuedAt > TOKEN_TTL_MS) return null;
  return { phone: parts[0], cooperativeId: parts[1], role: parts[2] };
}

export async function adminApiRoutes(app: FastifyInstance) {
  app.post("/api/admin/login", async (req, reply) => {
    const body = req.body as { phone?: string; pin?: string };
    const phone = body.phone?.replace(/[^0-9]/g, "");
    const pin = body.pin;
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.ip;

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
      where: { phone, role: "admin" },
      include: { cooperative: true },
    });
    if (!member || !member.pin || !verifyPin(pin, member.pin)) {
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
    const auth = req.headers.authorization;
    const payload = auth?.startsWith("Bearer ") ? verify(auth.slice(7)) : null;
    if (!payload) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    req.adminPhone = payload.phone;
    req.adminCoopId = payload.cooperativeId;
    req.adminRole = payload.role;
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
        prisma.wallet.aggregate({ _sum: { balance: true, totalSaved: true } }),
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
      include: { wallet: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
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
    const { id } = req.params as { id: string };
    const loan = await prisma.loan.findFirst({ where: { id, cooperativeId: coopId } });
    if (!loan) return reply.code(404).send({ error: "loan not found" });
    if (loan.status !== "guaranteed") {
      return reply.code(400).send({ error: `loan must have 2 confirmed guarantors first (current: ${loan.status})` });
    }

    const rate = loan.interestRate;
    const total = loan.amount * (1 + (rate / 100) * loan.tenureMonths);
    const monthly = total / loan.tenureMonths;
    const due = new Date();
    due.setMonth(due.getMonth() + 1);

    const updated = await prisma.loan.update({
      where: { id },
      data: {
        status: "approved",
        monthlyPayment: Math.round(monthly * 100) / 100,
        balance: Math.round(total * 100) / 100,
        approvedAt: new Date(),
        dueDate: due,
      },
    });
    return updated;
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
}

async function requireAdminCoop(phone: string): Promise<string> {
  const member = await prisma.member.findFirst({ where: { phone, role: "admin" } });
  if (!member) throw new Error("not an admin");
  return member.cooperativeId;
}