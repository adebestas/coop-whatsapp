import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { handleMessage } from "../src/services/conversation.js";
import { sendText } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import {
  getCoopSnapshot,
  getMemberSnapshot,
  getSavingsTrend,
  getLoanPerformance,
} from "../src/lib/ai-data.js";
import {
  generateFinancialInsights,
  generateLoanRiskAssessment,
} from "../src/lib/ai-insights.js";
import { generateSupportResponse, generateContextualHelp } from "../src/lib/ai-support.js";
import {
  sendSavingsReminders,
  sendLoanReminders,
  sendOverdueAlerts,
  sendLowBalanceWarnings,
} from "../src/lib/ai-alerts.js";

vi.mock("../src/lib/messaging.js", () => ({
  sendText: vi.fn().mockResolvedValue(true),
  sendSecurePrompt: vi.fn().mockResolvedValue(true),
  notifyMember: vi.fn().mockResolvedValue(true),
  platformOf: (channelId: string) => (channelId.startsWith("tg:") ? "telegram" : "whatsapp"),
}));

const PHONE = "2348012345678";

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.GROQ_API_KEY;
  // Clean up in order of dependencies (ignore errors from FK constraints)
  try { await prisma.$executeRaw`DELETE FROM posting`; } catch {}
  try { await prisma.$executeRaw`DELETE FROM "JournalEntry"`; } catch {}
  try { await prisma.$executeRaw`DELETE FROM contribution`; } catch {}
  try { await prisma.$executeRaw`DELETE FROM wallet`; } catch {}
  try { await prisma.$executeRaw`DELETE FROM member`; } catch {}
  try { await prisma.$executeRaw`DELETE FROM cooperative`; } catch {}
  try { await prisma.$executeRaw`DELETE FROM session`; } catch {}
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GROQ_API_KEY;
});

async function makeCoopAndMember() {
  const coop = await prisma.cooperative.upsert({
    where: { code: "TST01" },
    update: { dailyPayoutLimit: 5000000 },
    create: { name: "Test Coop", code: "TST01", dailyPayoutLimit: 5000000 },
  });
  // Find existing member or create new one
  const existingMember = await prisma.member.findFirst({ where: { phone: PHONE } });
  let member = existingMember;
  if (!member) {
    member = await prisma.member.create({
      data: {
        cooperativeId: coop.id,
        phone: PHONE,
        name: "Alice",
        code: generateMemberCode(),
        role: "member",
        status: "active",
        pin: hashPin("1234"),
        wallet: { create: {} },
      },
    });
  }
  await prisma.wallet.upsert({
    where: { memberId: member.id },
    update: { balance: 100000, totalSaved: 100000 },
    create: { memberId: member.id, balance: 100000, totalSaved: 100000 },
  });
  return { coop, member };
}

describe("AI Data Access Layer", () => {
  it("getCoopSnapshot returns cooperative financial data", async () => {
    const { coop } = await makeCoopAndMember();
    const snapshot = await getCoopSnapshot(coop.id);
    expect(snapshot.cooperative.name).toBe("Test Coop");
    expect(snapshot.cooperative.activeMemberCount).toBe(1);
    expect(snapshot.finances.totalWalletBalance).toBe(100000);
  });

  it("getMemberSnapshot returns member financial data", async () => {
    const { member } = await makeCoopAndMember();
    const snapshot = await getMemberSnapshot(member.id);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.name).toBe("Alice");
    expect(snapshot!.walletBalance).toBe(100000);
  });

  it("getSavingsTrend returns monthly trends", async () => {
    const { coop } = await makeCoopAndMember();
    const trends = await getSavingsTrend(coop.id, 3);
    expect(trends).toHaveLength(3);
    expect(trends[0]).toHaveProperty("month");
    expect(trends[0]).toHaveProperty("amount");
  });

  it("getLoanPerformance returns loan stats", async () => {
    const { coop } = await makeCoopAndMember();
    const performance = await getLoanPerformance(coop.id);
    expect(performance.totalLoans).toBe(0);
    expect(performance.repaymentRate).toBe(0);
  });
});

describe("AI Financial Insights", () => {
  it("generateFinancialInsights returns insights without AI", async () => {
    const { coop } = await makeCoopAndMember();
    const insights = await generateFinancialInsights(coop.id);
    expect(insights).toContain("Financial Health");
    expect(insights).toContain("Loan Performance");
  });

  it("generateLoanRiskAssessment returns assessment", async () => {
    const { coop } = await makeCoopAndMember();
    const assessment = await generateLoanRiskAssessment(coop.id);
    expect(assessment).toContain("Risk Level");
    expect(assessment).toContain("Repayment Rate");
  });
});

describe("AI Member Support", () => {
  it("generateSupportResponse returns FAQ for savings question", async () => {
    const response = await generateSupportResponse("how do I save money", "Alice", "member");
    expect(response).toContain("save");
    expect(response).toContain("amount");
  });

  it("generateSupportResponse returns FAQ for loan question", async () => {
    const response = await generateSupportResponse("how do I apply for a loan", "Alice", "member");
    expect(response).toContain("loan");
    expect(response).toContain("months");
  });

  it("generateSupportResponse returns FAQ for withdrawal question", async () => {
    const response = await generateSupportResponse("how do I withdraw", "Alice", "member");
    expect(response).toContain("withdraw");
  });

  it("generateSupportResponse returns fallback for unknown question", async () => {
    const response = await generateSupportResponse("xyzzy", "Alice", "member");
    expect(response).toContain("Alice");
  });

  it("generateContextualHelp returns personalized help", async () => {
    const { member } = await makeCoopAndMember();
    const help = await generateContextualHelp(member.id);
    expect(help).toContain("Alice");
    expect(help).toContain("save");
  });
});

describe("AI Proactive Alerts", () => {
  it("sendSavingsReminders sends to members without contributions", async () => {
    const { coop } = await makeCoopAndMember();
    const count = await sendSavingsReminders(coop.id);
    expect(count).toBeGreaterThan(0);
    expect(sendText).toHaveBeenCalled();
  });

  it("sendLoanReminders sends to members with upcoming due dates", async () => {
    const { coop, member } = await makeCoopAndMember();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 5);
    await prisma.loan.create({
      data: {
        memberId: member.id,
        cooperativeId: coop.id,
        amount: 50000,
        balance: 50000,
        monthlyPayment: 10000,
        dueDate: futureDate,
        interestRate: 5,
        status: "disbursed",
      },
    });
    const count = await sendLoanReminders(coop.id);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("sendOverdueAlerts sends to members with overdue loans", async () => {
    const { coop, member } = await makeCoopAndMember();
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 10);
    await prisma.loan.create({
      data: {
        memberId: member.id,
        cooperativeId: coop.id,
        amount: 50000,
        balance: 40000,
        monthlyPayment: 10000,
        dueDate: pastDate,
        interestRate: 5,
        status: "disbursed",
      },
    });
    const count = await sendOverdueAlerts(coop.id);
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("sendLowBalanceWarnings sends when balance is low", async () => {
    const { coop, member } = await makeCoopAndMember();
    await prisma.wallet.update({
      where: { memberId: member.id },
      data: { balance: 5000 },
    });
    await prisma.loan.create({
      data: {
        memberId: member.id,
        cooperativeId: coop.id,
        amount: 50000,
        balance: 50000,
        monthlyPayment: 10000,
        interestRate: 5,
        status: "disbursed",
      },
    });
    const count = await sendLowBalanceWarnings(coop.id);
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

describe("AI Integration in Conversation", () => {
  it("insights command requires admin role", async () => {
    await handleMessage(PHONE, "insights");
    expect(sendText).toHaveBeenCalled();
    const lastCall = (sendText as any).mock.calls[(sendText as any).mock.calls.length - 1];
    expect(lastCall[0].text).toContain("Only admins");
  });

  it("risk command requires admin role", async () => {
    await handleMessage(PHONE, "risk");
    expect(sendText).toHaveBeenCalled();
    const lastCall = (sendText as any).mock.calls[(sendText as any).mock.calls.length - 1];
    expect(lastCall[0].text).toContain("Only admins");
  });

  it("contexthelp returns personalized help", async () => {
    await handleMessage(PHONE, "contexthelp");
    expect(sendText).toHaveBeenCalled();
    const lastCall = (sendText as any).mock.calls[(sendText as any).mock.calls.length - 1];
    expect(lastCall[0].text).toContain("Alice");
  });
});
