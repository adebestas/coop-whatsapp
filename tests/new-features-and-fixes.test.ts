import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./setup.js";
import { sendText, sendDocument } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { handleMessage } from "../src/services/conversation.js";
import { applyForLoan } from "../src/services/loans.js";
import { canWithdraw } from "../src/services/withdrawals.js";
import { setAutoSave } from "../src/services/scheduler.js";
import { formatMyGuarantees } from "../src/services/guarantors.js";
import { getBalanceTrendData, getBalanceTrend } from "../src/services/balance-trend.js";
import { generateEStatementPdf, resolveStatementPeriod } from "../src/services/estatement.js";
import { calculateGoalProjection } from "../src/services/savings-goals.js";
import { withCoopContext } from "../src/lib/tenant-context.js";

function uniqueCode(prefix: string) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

async function makeCoop(name = "Test Coop") {
  return prisma.cooperative.create({ data: { name, code: uniqueCode("TC"), adminPhone: null } });
}

async function makeMember(
  phone: string,
  coopId: string,
  name = "Test Member",
  role = "member",
  savingsKobo = 5000000, // ₦50,000
) {
  let code = generateMemberCode();
  while (await prisma.member.findUnique({ where: { code } })) {
    code = generateMemberCode();
  }
  return prisma.member.create({
    data: {
      code,
      phone,
      name,
      cooperativeId: coopId,
      role,
      pin: hashPin("1234"),
      consentAt: new Date(),
      wallet: { create: { balance: savingsKobo, totalSaved: savingsKobo } },
    },
    include: { wallet: true },
  });
}

describe("New Features & Bug Fixes Verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Bug Fixes Verification", () => {
    it("BUG-1: applyForLoan respects active cooperative context in multi-coop setup", async () => {
      const coop1 = await makeCoop("Coop Alpha");
      const coop2 = await makeCoop("Coop Beta");
      const sharedPhone = "2348077770001";

      const m1 = await makeMember(sharedPhone, coop1.id, "Member Alpha", "member", 2000000); // ₦20k
      const m2 = await makeMember(sharedPhone, coop2.id, "Member Beta", "member", 8000000); // ₦80k

      // In coop2 context, apply for loan
      const result = await withCoopContext(
        coop2.id,
        () => applyForLoan(sharedPhone, 10000000, 3), // ₦100,000 loan (exceeds coop1 2x cap, fits coop2 2x cap)
      );

      expect(result.ok).toBe(true);
      expect(result.loanId).toBeDefined();

      const createdLoan = await prisma.loan.findUnique({ where: { id: result.loanId! } });
      expect(createdLoan?.cooperativeId).toBe(coop2.id);
      expect(createdLoan?.memberId).toBe(m2.id);
    });

    it("BUG-4: canWithdraw returns strongly-typed member with wallet", async () => {
      const coop = await makeCoop("Withdraw Coop");
      const member = await makeMember("2348077770002", coop.id, "Saver", "member", 1000000);

      const result = await canWithdraw(member.phone);
      expect(result.ok).toBe(true);
      expect(result.member).toBeDefined();
      expect(result.member?.wallet?.balance).toBe(1000000);
    });

    it("BUG-10: setAutoSave respects cooperative context", async () => {
      const coop1 = await makeCoop("AutoSave Coop 1");
      const coop2 = await makeCoop("AutoSave Coop 2");
      const phone = "2348077770003";

      const m1 = await makeMember(phone, coop1.id, "Saver 1");
      const m2 = await makeMember(phone, coop2.id, "Saver 2");

      await withCoopContext(coop2.id, () => setAutoSave(phone, 500000, "weekly"));

      const fresh1 = await prisma.member.findUnique({ where: { id: m1.id } });
      const fresh2 = await prisma.member.findUnique({ where: { id: m2.id } });

      expect(fresh1?.autoSaveEnabled).toBe(false);
      expect(fresh2?.autoSaveEnabled).toBe(true);
      expect(fresh2?.autoSaveAmount).toBe(500000);
    });

    it("BUG-6: formatMyGuarantees partitions confirmed commitments vs pending requests", () => {
      const summary = {
        guarantees: [
          {
            id: "g1",
            code: "GCODE1",
            status: "confirmed",
            confirmedAt: new Date(),
            borrowerName: "Amina Yusuf",
            borrowerCode: "AMIN01",
            borrowerPhone: "2348011111111",
            loanId: "l1",
            loanAmount: 5000000,
            loanBalance: 4000000,
            loanStatus: "disbursed",
            exposure: 4000000,
          },
          {
            id: "g2",
            code: "GCODE2",
            status: "pending",
            confirmedAt: null,
            borrowerName: "Emeka Okafor",
            borrowerCode: "EMEK02",
            borrowerPhone: "2348022222222",
            loanId: "l2",
            loanAmount: 3000000,
            loanBalance: 3000000,
            loanStatus: "pending",
            exposure: 0,
          },
        ],
        activeCount: 1,
        maxActive: 2,
        totalExposure: 4000000,
        totalSavings: 6000000,
        exposureLimit: 12000000,
        availableGuaranteeLimit: 8000000,
      };

      const formatted = formatMyGuarantees(summary, "Chief Test");
      expect(formatted).toContain("Active Commitments");
      expect(formatted).toContain("Amina Yusuf");
      expect(formatted).toContain("Requests Awaiting Your Confirmation");
      expect(formatted).toContain("Emeka Okafor");
      expect(formatted).toContain("confirm GCODE2");
    });
  });

  describe("Feature 1: Balance Trend Sparkline", () => {
    it("computes 6-month savings trend and renders sparkline", async () => {
      const coop = await makeCoop("Trend Coop");
      const member = await makeMember("2348088880001", coop.id, "Trend Member");

      const now = new Date(2026, 9, 28); // Oct 2026

      // Create contributions across months
      await prisma.contribution.createMany({
        data: [
          {
            reference: uniqueCode("REF1"),
            amount: 1000000, // ₦10k
            status: "confirmed",
            paidAt: new Date(2026, 7, 15), // Aug 2026
            memberId: member.id,
            cooperativeId: coop.id,
          },
          {
            reference: uniqueCode("REF2"),
            amount: 2500000, // ₦25k
            status: "confirmed",
            paidAt: new Date(2026, 8, 10), // Sep 2026
            memberId: member.id,
            cooperativeId: coop.id,
          },
          {
            reference: uniqueCode("REF3"),
            amount: 5000000, // ₦50k
            status: "confirmed",
            paidAt: new Date(2026, 9, 5), // Oct 2026
            memberId: member.id,
            cooperativeId: coop.id,
          },
        ],
      });

      const trendData = await getBalanceTrendData(member.id, coop.id, now);
      expect(trendData.totalKobo).toBe(8500000);
      expect(trendData.bestMonth?.totalKobo).toBe(5000000);
      expect(trendData.growthPct).toBe(100); // 50k vs 25k = +100%

      const text = await getBalanceTrend(member.id, coop.id, now);
      expect(text).toContain("Your 6-Month Savings Trend");
      expect(text).toContain("Total saved (last 6 months)");
      expect(text).toContain("Best month");
    });

    it("handles `trend` chat command", async () => {
      const coop = await makeCoop("Trend Chat Coop");
      const member = await makeMember("2348088880002", coop.id, "Chat Trend Member");

      await handleMessage(member.phone, "trend");

      expect(sendText).toHaveBeenCalled();
      const lastCall = vi.mocked(sendText).mock.calls.at(-1)?.[0];
      expect(lastCall?.text).toContain("Your 6-Month Savings Trend");
    });
  });

  describe("Feature 2: E-Statement PDF Generator", () => {
    it("parses statement month periods correctly", () => {
      const now = new Date(2026, 9, 28); // Oct 2026
      const oct = resolveStatementPeriod("oct", now);
      expect(oct.start.getMonth()).toBe(9);
      expect(oct.label).toContain("October 2026");

      const last = resolveStatementPeriod("last", now);
      expect(last.start.getMonth()).toBe(8); // Sep
      expect(last.label).toContain("September 2026");

      const iso = resolveStatementPeriod("2026-05", now);
      expect(iso.start.getMonth()).toBe(4); // May
      expect(iso.label).toContain("May 2026");
    });

    it("generates a valid PDF buffer for an e-statement", async () => {
      const buffer = await generateEStatementPdf({
        cooperativeName: "Apex Thrift Cooperative",
        memberName: "Folake Bakare",
        memberCode: "FOL001",
        memberPhone: "2348012345678",
        periodLabel: "October 2026",
        generatedAt: new Date(),
        openingBalance: 10000000,
        closingBalance: 15000000,
        totalCredit: 6000000,
        totalDebit: 1000000,
        transactions: [
          {
            date: new Date(2026, 9, 5),
            description: "Monthly Savings",
            type: "credit",
            amount: 6000000,
          },
          {
            date: new Date(2026, 9, 15),
            description: "Emergency Withdrawal",
            type: "debit",
            amount: 1000000,
          },
        ],
      });

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(1000);
      expect(buffer.toString("utf8", 0, 5)).toContain("%PDF");
    });

    it("handles `estatement` chat command and dispatches PDF document", async () => {
      const coop = await makeCoop("EStatement Chat Coop");
      const member = await makeMember("2348088880003", coop.id, "Statement Member");

      await handleMessage(member.phone, "estatement oct");

      expect(sendDocument).toHaveBeenCalled();
      const docCall = vi.mocked(sendDocument).mock.calls.at(-1)?.[0];
      expect(docCall?.to).toBe(member.phone);
      expect(docCall?.filename).toContain("Statement_October_2026");
      expect(docCall?.mimeType).toBe("application/pdf");
    });
  });

  describe("Feature 3: Savings Goals Planner", () => {
    it("projects timeline to reach target based on savings history", async () => {
      const coop = await makeCoop("Goal Coop");
      const member = await makeMember("2348099990001", coop.id, "Goal Setter", "member", 4000000); // ₦40,000

      // Add recent contributions: ₦30,000 over 90 days = ₦10,000/mo
      await prisma.contribution.create({
        data: {
          reference: uniqueCode("REF-GOAL"),
          amount: 3000000,
          status: "confirmed",
          paidAt: new Date(),
          memberId: member.id,
          cooperativeId: coop.id,
        },
      });

      const response = await calculateGoalProjection(member.id, 10000000); // Target ₦100k, remaining ₦60k
      expect(response).toContain("Savings Goal Plan");
      expect(response).toContain("Target Goal: *₦100,000.00*");
      expect(response).toContain("Current Balance: *₦40,000.00*");
      expect(response).toContain("Remaining: *₦60,000.00*");
      expect(response).toContain("6 months");
    });

    it("handles target date and recommends required monthly contribution", async () => {
      const coop = await makeCoop("Goal Target Coop");
      const member = await makeMember(
        "2348099990002",
        coop.id,
        "Target Date Member",
        "member",
        2000000,
      ); // ₦20k

      const now = new Date(2026, 9, 28);
      const response = await calculateGoalProjection(member.id, 14000000, "Dec 2027", now); // ₦140k target

      expect(response).toContain("Savings Goal Plan");
      expect(response).toContain("To reach your goal by December 2027");
      expect(response).toContain("plan");
    });

    it("handles `goal` chat command", async () => {
      const coop = await makeCoop("Goal Chat Coop");
      const member = await makeMember(
        "2348099990003",
        coop.id,
        "Chat Goal Member",
        "member",
        1000000,
      );

      await handleMessage(member.phone, "goal 500000 Dec 2027");

      expect(sendText).toHaveBeenCalled();
      const lastCall = vi.mocked(sendText).mock.calls.at(-1)?.[0];
      expect(lastCall?.text).toContain("Savings Goal Plan");
      expect(lastCall?.text).toContain("Target Goal: *₦500,000.00*");
    });
  });
});
