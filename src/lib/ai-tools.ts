/**
 * AI tool registry — the single place that declares what data the assistant
 * can reach and what permission each tool requires.
 *
 * The model only classifies a question into a tool name; the server looks the
 * tool up here, enforces `requiredRole` / `scope` in code, and runs the
 * handler. The model never chooses which data to fetch and never bypasses a
 * permission check.
 */

import { prisma } from "./prisma.js";
import {
  getCoopSnapshot,
  getMemberSnapshot,
  getSavingsTrend,
  getLoanPerformance,
  getFinancialMemory,
} from "./ai-data.js";

export interface AIToolContext {
  cooperativeId: string;
  memberId?: string;
  role: string;
}

export interface AITool {
  name: string;
  description: string;
  /** "self" = the caller's own data (needs memberId); "coop" = aggregate data. */
  scope: "self" | "coop";
  /** Minimum role required. Undefined = any member. */
  requiredRole?: "admin" | "superadmin";
  handler: (ctx: AIToolContext) => Promise<Record<string, unknown>>;
}

function requireMember(ctx: AIToolContext): string {
  if (!ctx.memberId) throw new Error("MEMBER_REQUIRED");
  return ctx.memberId;
}

export const AI_TOOLS: Record<string, AITool> = {
  member_balance: {
    name: "member_balance",
    description: "The member's own wallet balance and active loan",
    scope: "self",
    handler: async (ctx) => ({ member: await getMemberSnapshot(requireMember(ctx)) }),
  },
  member_savings: {
    name: "member_savings",
    description: "The member's own contribution history and savings trend",
    scope: "self",
    handler: async (ctx) => ({
      member: await getMemberSnapshot(requireMember(ctx)),
      trends: await getSavingsTrend(ctx.cooperativeId, 6),
    }),
  },
  member_loan: {
    name: "member_loan",
    description: "The member's own loan status and remaining balance",
    scope: "self",
    handler: async (ctx) => ({ member: await getMemberSnapshot(requireMember(ctx)) }),
  },
  member_affordability: {
    name: "member_affordability",
    description: "The member's own borrowing capacity and savings trajectory",
    scope: "self",
    handler: async (ctx) => ({ memory: await getFinancialMemory(requireMember(ctx)) }),
  },
  coop_overview: {
    name: "coop_overview",
    description: "Cooperative totals, member count, and financial health",
    scope: "coop",
    handler: async (ctx) => ({ snapshot: await getCoopSnapshot(ctx.cooperativeId) }),
  },
  coop_contributions: {
    name: "coop_contributions",
    description: "Group contribution totals for this month, last month, and this year",
    scope: "coop",
    handler: async (ctx) => ({ snapshot: await getCoopSnapshot(ctx.cooperativeId) }),
  },
  coop_loans: {
    name: "coop_loans",
    description: "Group loan counts by status and average interest rate",
    scope: "coop",
    handler: async (ctx) => ({ snapshot: await getCoopSnapshot(ctx.cooperativeId) }),
  },
  coop_withdrawals: {
    name: "coop_withdrawals",
    description: "Pending withdrawals and daily payout totals",
    scope: "coop",
    handler: async (ctx) => ({ snapshot: await getCoopSnapshot(ctx.cooperativeId) }),
  },
  coop_trends: {
    name: "coop_trends",
    description: "Savings growth over the last six months",
    scope: "coop",
    handler: async (ctx) => ({ trends: await getSavingsTrend(ctx.cooperativeId, 6) }),
  },
  coop_performance: {
    name: "coop_performance",
    description: "Loan repayment rate and defaulted-loan count",
    scope: "coop",
    handler: async (ctx) => ({ performance: await getLoanPerformance(ctx.cooperativeId) }),
  },
  member_list: {
    name: "member_list",
    description: "List of members (names are PII — admin only)",
    scope: "coop",
    requiredRole: "admin",
    handler: async (ctx) => {
      const members = await prisma.member.findMany({
        where: { cooperativeId: ctx.cooperativeId, status: "active" },
        select: { name: true, code: true, role: true },
        orderBy: { name: "asc" },
      });
      return { members: members.slice(0, 20), total: members.length };
    },
  },
  help: {
    name: "help",
    description: "What the assistant can answer",
    scope: "coop",
    handler: async () => ({}),
  },
};

/** Central permission check for a tool. */
export function canUseTool(tool: AITool, role: string): boolean {
  if (!tool.requiredRole) return true;
  if (tool.requiredRole === "admin") return role === "admin" || role === "superadmin";
  return role === "superadmin";
}
