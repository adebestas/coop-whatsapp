/**
 * AI Query Engine — natural language queries about cooperative data.
 *
 * Members can ask questions like:
 *   - "How much have I saved this month?"
 *   - "What's our total balance?"
 *   - "How many loans are pending?"
 *   - "Show me savings trends"
 *   - "Who hasn't contributed this month?"
 *   - "What's the loan repayment rate?"
 *
 * SECURITY: All queries are read-only. No PII is exposed to the AI.
 * Member-specific data requires authentication. Admin data requires admin role.
 */

import { prisma } from "./prisma.js";
import {
  getCoopSnapshot,
  getMemberSnapshot,
  getSavingsTrend,
  getLoanPerformance,
  type CoopSnapshot,
  type MemberSnapshot,
} from "./ai-data.js";
import { GROQ_URL, groqAvailable, groqModel, groqHeaders, GROQ_TIMEOUT_MS, groqFetch } from "./groq.js";

/** Sleep for the given milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch with exponential backoff retry. Only retries on 5xx errors.
 * Max 3 retries with delays of 1s, 2s, 4s.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);
      // Only retry on 5xx server errors, not 4xx client errors
      if (res.ok || res.status < 500) return res;
      lastError = new Error(`HTTP ${res.status}`);
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await sleep(delay);
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

export type AIQueryType =
  | "member_balance"
  | "member_savings"
  | "member_loan"
  | "coop_overview"
  | "coop_contributions"
  | "coop_loans"
  | "coop_withdrawals"
  | "coop_trends"
  | "coop_performance"
  | "member_list"
  | "help";

interface AIQueryIntent {
  type: AIQueryType;
  args: Record<string, string>;
}

/**
 * Classify the user's natural language query into a structured intent.
 */
async function classifyIntent(text: string): Promise<AIQueryIntent | null> {
  if (!groqAvailable()) return null;

  try {
    const res = await groqFetch({
      model: groqModel(),
      temperature: 0,
      max_tokens: 150,
      messages: [
        {
          role: "system",
          content: `You classify Nigerian cooperative banking questions into intents.

Reply with STRICT JSON only: {"type":"<intent>","args":{}}

Valid intents:
- "member_balance" — asking about own wallet balance, savings, account balance
- "member_savings" — asking about own contribution history, savings trends
- "member_loan" — asking about own loan status, repayment, remaining balance
- "coop_overview" — asking about cooperative's total savings, members, general health
- "coop_contributions" — asking about group contributions, this month, total
- "coop_loans" — asking about group loans, pending, disbursed, repaid
- "coop_withdrawals" — asking about pending withdrawals, payout status
- "coop_trends" — asking about savings trends, growth, comparisons
- "coop_performance" — asking about repayment rates, performance metrics
- "member_list" — asking about specific members, who has/hasn't done something
- "help" — asking what they can ask about

Args can include:
- "period": "this_month", "last_month", "this_year", "all"
- "target": "me", "all", "coop"

If unsure, return {"type":"help","args":{}}`,
        },
        { role: "user", content: text },
      ],
    }, GROQ_TIMEOUT_MS);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = body.choices?.[0]?.message?.content ?? "";
    const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const parsed = JSON.parse(jsonText) as { type?: string; args?: Record<string, string> };
    if (!parsed.type) return null;

    const validTypes: AIQueryType[] = [
      "member_balance", "member_savings", "member_loan",
      "coop_overview", "coop_contributions", "coop_loans",
      "coop_withdrawals", "coop_trends", "coop_performance",
      "member_list", "help",
    ];
    if (!validTypes.includes(parsed.type as AIQueryType)) return null;

    return {
      type: parsed.type as AIQueryType,
      args: parsed.args ?? {},
    };
  } catch {
    return null;
  }
}

/**
 * Generate a natural language response from the AI using the data.
 */
async function generateResponse(
  question: string,
  intent: AIQueryType,
  data: Record<string, unknown>,
): Promise<string> {
  if (!groqAvailable()) return "AI is not available.";

  const systemPrompt = `You are a cooperative banking assistant for a Nigerian cooperative.
Answer the member's question using the provided data. Be concise and helpful.
Use the format: ₦XX,XXX for amounts. Use bold for emphasis.
If data shows zero or empty, say so clearly. Be warm and professional.
Never make up data. Only use what's provided.`;

  try {
    const res = await groqFetch({
      model: groqModel(),
      temperature: 0.3,
      max_tokens: 300,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Question: ${question}\n\nData (JSON):\n${JSON.stringify(data, null, 2)}`,
        },
      ],
    }, GROQ_TIMEOUT_MS);
    if (!res.ok) return formatFallbackResponse(intent, data);
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return body.choices?.[0]?.message?.content ?? formatFallbackResponse(intent, data);
  } catch {
    return formatFallbackResponse(intent, data);
  }
}

/**
 * Format a deterministic fallback response when AI is unavailable.
 */
function formatFallbackResponse(intent: AIQueryType, data: Record<string, unknown>): string {
  const fmt = (n: number) => `₦${(n / 100).toLocaleString()}`;

  switch (intent) {
    case "member_balance": {
      const d = data as { member: MemberSnapshot };
      return (
        `💰 Your Balance\n\n` +
        `Wallet: *${fmt(d.member.walletBalance)}*\n` +
        `Total saved: *${fmt(d.member.totalSaved)}*\n` +
        (d.member.activeLoan
          ? `Active loan: *${fmt(d.member.activeLoan.balance)}* remaining\nMonthly payment: ${fmt(d.member.activeLoan.monthlyPayment)}`
          : `No active loans`)
      );
    }
    case "member_savings": {
      const d = data as { member: MemberSnapshot; trends: { month: string; amount: number }[] };
      let msg = `📊 Your Savings\n\nContributions: ${d.member.contributionCount}\n`;
      if (d.trends.length) {
        msg += `\nMonthly:\n`;
        d.trends.forEach((t) => {
          msg += `  ${t.month}: ${fmt(t.amount)}\n`;
        });
      }
      return msg;
    }
    case "member_loan": {
      const d = data as { member: MemberSnapshot };
      if (!d.member.activeLoan) return "📄 You have no active loans.";
      const loan = d.member.activeLoan;
      return (
        `📄 Your Loan\n\n` +
        `Amount: *${fmt(loan.amount)}*\n` +
        `Remaining: *${fmt(loan.balance)}*\n` +
        `Monthly payment: *${fmt(loan.monthlyPayment)}*\n` +
        (loan.dueDate ? `Due: ${loan.dueDate}` : "")
      );
    }
    case "coop_overview": {
      const d = data as { snapshot: CoopSnapshot };
      const s = d.snapshot;
      return (
        `🏦 *${s.cooperative.name}* Overview\n\n` +
        `Members: ${s.cooperative.activeMemberCount}/${s.cooperative.memberCount} active\n` +
        `Total saved: *${fmt(s.finances.totalSaved)}*\n` +
        `Wallet balance: *${fmt(s.finances.totalWalletBalance)}*\n` +
        `Active loan balance: *${fmt(s.finances.activeLoanBalance)}*\n` +
        `Pending withdrawals: ${s.finances.pendingWithdrawals} (${fmt(s.finances.pendingWithdrawalAmount)})`
      );
    }
    case "coop_contributions": {
      const d = data as { snapshot: CoopSnapshot };
      return (
        `📊 Contributions\n\n` +
        `This month: *${fmt(d.snapshot.contributions.thisMonth)}* (${d.snapshot.contributions.count} txns)\n` +
        `Last month: *${fmt(d.snapshot.contributions.lastMonth)}*\n` +
        `This year: *${fmt(d.snapshot.contributions.thisYear)}*`
      );
    }
    case "coop_loans": {
      const d = data as { snapshot: CoopSnapshot };
      return (
        `📄 Loans\n\n` +
        `Pending approval: ${d.snapshot.loans.pending}\n` +
        `Approved: ${d.snapshot.loans.approved}\n` +
        `Disbursed: ${d.snapshot.loans.disbursed}\n` +
        `Fully repaid: ${d.snapshot.loans.paid}\n` +
        `Rejected: ${d.snapshot.loans.rejected}\n` +
        `Avg interest rate: ${d.snapshot.loans.averageInterestRate.toFixed(1)}%`
      );
    }
    case "coop_withdrawals": {
      const d = data as { snapshot: CoopSnapshot };
      return (
        `💸 Withdrawals\n\n` +
        `Pending: ${d.snapshot.finances.pendingWithdrawals}\n` +
        `Amount: *${fmt(d.snapshot.finances.pendingWithdrawalAmount)}*\n` +
        `Today paid out: *${fmt(d.snapshot.finances.todayPayoutTotal)}*\n` +
        `Daily limit: *${fmt(d.snapshot.finances.dailyPayoutLimit)}*`
      );
    }
    case "coop_trends": {
      const d = data as { trends: { month: string; amount: number }[] };
      let msg = `📈 Savings Trends\n\n`;
      d.trends.forEach((t) => {
        msg += `${t.month}: ${fmt(t.amount)}\n`;
      });
      return msg;
    }
    case "coop_performance": {
      const d = data as { performance: ReturnType<typeof getLoanPerformance> extends Promise<infer T> ? T : never };
      return (
        `📈 Loan Performance\n\n` +
        `Total loans: ${d.performance.totalLoans}\n` +
        `Repaid: ${d.performance.paidLoans}\n` +
        `Repayment rate: ${d.performance.repaymentRate.toFixed(1)}%\n` +
        `Defaulted: ${d.performance.defaultedLoans}`
      );
    }
    case "help":
      return (
        `🤖 I can help with:\n\n` +
        `• *My balance* — check your wallet\n` +
        `• *My savings* — see your contribution history\n` +
        `• *My loan* — check loan status\n` +
        `• *Coop overview* — total savings, members, health\n` +
        `• *Contributions* — group contribution stats\n` +
        `• *Loans* — group loan stats\n` +
        `• *Withdrawals* — pending withdrawals\n` +
        `• *Trends* — savings growth over time\n` +
        `• *Performance* — loan repayment rates`
      );
    default:
      return "I can help you check balances, savings, loans, and cooperative stats. Try asking about any of those!";
  }
}

/**
 * Handle a natural language AI query about cooperative/member data.
 * Returns the response text, or null if the query cannot be handled.
 */
export async function handleAIQuery(
  text: string,
  phone: string,
  role: string,
  cooperativeId: string,
  memberId?: string,
): Promise<string | null> {
  // Enforce input length limit to prevent abuse and excessive token usage
  const truncated = text.slice(0, 500);

  // 1. Classify intent
  const intent = await classifyIntent(truncated);
  if (!intent) return null;

  // 2. Gather data based on intent
  let data: Record<string, unknown> = {};

  switch (intent.type) {
    case "member_balance":
    case "member_savings":
    case "member_loan": {
      if (!memberId) {
        return "Please register first to check your personal data. Reply *join <code>* to get started.";
      }
      const member = await getMemberSnapshot(memberId);
      if (!member) return "Could not find your member data.";
      const trends =
        intent.type === "member_savings"
          ? await getSavingsTrend(cooperativeId, 6)
          : [];
      data = { member, trends };
      break;
    }

    case "coop_overview":
    case "coop_contributions":
    case "coop_loans":
    case "coop_withdrawals": {
      const snapshot = await getCoopSnapshot(cooperativeId);
      data = { snapshot };
      break;
    }

    case "coop_trends": {
      const trends = await getSavingsTrend(cooperativeId, 6);
      data = { trends };
      break;
    }

    case "coop_performance": {
      const performance = await getLoanPerformance(cooperativeId);
      data = { performance };
      break;
    }

    case "member_list": {
      const members = await prisma.member.findMany({
        where: { cooperativeId, status: "active" },
        select: { name: true, code: true, role: true },
        orderBy: { name: "asc" },
      });
      data = { members: members.slice(0, 20), total: members.length };
      break;
    }

    case "help":
      data = {};
      break;
  }

  // 3. Generate response
  return generateResponse(truncated, intent.type, data);
}

/**
 * Check if a message looks like a natural language query (not a command).
 */
export function isNaturalLanguageQuery(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;
  if (/^[\d\s.,]+$/.test(trimmed)) return false;

  // Check if it looks like a question or statement (not a command)
  const questionPatterns = /^(how|what|when|where|who|why|show|tell|check|give|list|who|which)/i;
  const statementPatterns = /(balance|savings|loan|contribution|withdraw|payout|member|total|trend|performance)/i;

  return questionPatterns.test(trimmed) || statementPatterns.test(trimmed);
}
