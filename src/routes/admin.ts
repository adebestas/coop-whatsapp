import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { verifyPin } from "../lib/security.js";

/**
 * Minimal admin auth for the dashboard: members log in with their WhatsApp
 * phone + 4-digit PIN. The dashboard calls /api/admin/login which returns a
 * short-lived token (phone signed with the server secret). All other routes
 * require `Authorization: Bearer <token>`.
 */
import crypto from "node:crypto";

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

function sign(phone: string): string {
  const secret = process.env.ADMIN_JWT_SECRET ?? "dev-admin-secret-change-me";
  const payload = `${phone}.${Date.now()}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verify(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const secret = process.env.ADMIN_JWT_SECRET ?? "dev-admin-secret-change-me";
  const payload = `${parts[0]}.${parts[1]}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  if (sig !== parts[2]) return null;
  const issuedAt = Number(parts[1]);
  if (Date.now() - issuedAt > TOKEN_TTL_MS) return null;
  return parts[0];
}

export async function adminApiRoutes(app: FastifyInstance) {
  app.post("/api/admin/login", async (req, reply) => {
    const body = req.body as { phone?: string; pin?: string };
    const phone = body.phone?.replace(/[^0-9]/g, "");
    const pin = body.pin;

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

    const token = sign(phone);
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
    // Skip auth for login.
    if (req.url === "/api/admin/login") return;
    const auth = req.headers.authorization;
    const phone = auth?.startsWith("Bearer ") ? verify(auth.slice(7)) : null;
    if (!phone) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    req.adminPhone = phone;
  });

  app.get("/api/admin/overview", async (req) => {
    const coopId = await requireAdminCoop(req.adminPhone!);
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
    const coopId = await requireAdminCoop(req.adminPhone!);
    return prisma.member.findMany({
      where: { cooperativeId: coopId },
      include: { wallet: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  });

  app.get("/api/admin/loans", async (req) => {
    const coopId = await requireAdminCoop(req.adminPhone!);
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
    const coopId = await requireAdminCoop(req.adminPhone!);
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
    const coopId = await requireAdminCoop(req.adminPhone!);
    const { id } = req.params as { id: string };
    const loan = await prisma.loan.findFirst({ where: { id, cooperativeId: coopId } });
    if (!loan) return reply.code(404).send({ error: "loan not found" });
    if (loan.status !== "pending") return reply.code(400).send({ error: `loan is ${loan.status}` });
    return prisma.loan.update({ where: { id }, data: { status: "rejected" } });
  });

  app.get("/api/admin/payouts", async (req) => {
    const coopId = await requireAdminCoop(req.adminPhone!);
    return prisma.payout.findMany({
      where: { cooperativeId: coopId },
      include: { member: { select: { name: true, phone: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  app.get("/api/admin/contributions", async (req) => {
    const coopId = await requireAdminCoop(req.adminPhone!);
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