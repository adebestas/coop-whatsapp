import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./setup.js";
import { sendText, notifyMember } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { handleMessage } from "../src/services/conversation.js";
import { getMemberGuarantees, formatMyGuarantees } from "../src/services/guarantors.js";
import { collectCashDeposit, getCollectorDailySummary } from "../src/services/thrift-collector.js";
import { notifyMembersOfIngestedSchedule } from "../src/services/deduction-ingest.js";

function uniqueCode(prefix: string) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

async function makeCoop(name = "Coopvest Coop") {
  return prisma.cooperative.create({ data: { name, code: uniqueCode("CC"), adminPhone: null } });
}

async function makeMember(
  phone: string,
  coopId: string,
  name = "Test Member",
  role = "member",
  savingsKobo = 200000, // ₦2,000
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

describe("Coopvest-Inspired Features", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Feature 1: My Guarantees Portfolio Visibility", () => {
    it("returns correct contingent exposure and available limit for a guarantor", async () => {
      const coop = await makeCoop("Guarantee Test Coop");
      // Guarantor has ₦50,000 in savings -> 2x cap is ₦100,000
      const guarantor = await makeMember(
        "2348011110001",
        coop.id,
        "Guarantor Chief",
        "member",
        5000000,
      );
      const borrower = await makeMember(
        "2348011110002",
        coop.id,
        "Borrower One",
        "member",
        1000000,
      );

      // Create an active loan of ₦30,000 for borrower with guarantor confirmed
      const loan = await prisma.loan.create({
        data: {
          cooperativeId: coop.id,
          memberId: borrower.id,
          amount: 3000000,
          balance: 2500000, // ₦25,000 remaining
          status: "disbursed",
        },
      });

      await prisma.guarantor.create({
        data: {
          loanId: loan.id,
          memberId: guarantor.id,
          code: "GUARMEM01",
          status: "confirmed",
          confirmedAt: new Date(),
        },
      });

      const summary = await getMemberGuarantees(guarantor.id, coop.id);

      expect(summary.activeCount).toBe(1);
      expect(summary.totalSavings).toBe(5000000);
      expect(summary.exposureLimit).toBe(10000000); // 2x savings = ₦100,000
      expect(summary.totalExposure).toBe(2500000); // ₦25,000 outstanding balance
      expect(summary.availableGuaranteeLimit).toBe(7500000); // 100k - 25k = 75k

      const formatted = formatMyGuarantees(summary, guarantor.name);
      expect(formatted).toContain("My Guarantees Portfolio");
      expect(formatted).toContain("Borrower One");
      expect(formatted).toContain("1/2");
    });

    it("handles `myguarantees` command in chat session", async () => {
      const coop = await makeCoop("Chat Guarantee Coop");
      const member = await makeMember("2348022220001", coop.id, "Chat Member", "member", 1000000);

      await handleMessage(member.phone, "myguarantees");

      expect(sendText).toHaveBeenCalled();
      const lastCall = vi.mocked(sendText).mock.calls.at(-1)?.[0];
      expect(lastCall?.text).toContain("My Guarantees Portfolio");
      expect(lastCall?.text).toContain("You are not currently guaranteeing any active loans");
    });
  });

  describe("Feature 2: Automated Member Payroll Ingestion Alerts", () => {
    it("notifies members when employer deduction spreadsheet is ingested", async () => {
      const coop = await makeCoop("Ingest Coop");
      const m1 = await makeMember("2348033330001", coop.id, "Civil Servant A", "member", 100000);
      const m2 = await makeMember("2348033330002", coop.id, "Civil Servant B", "member", 100000);

      const rows = [
        { memberId: m1.id, amount: 1500000 }, // ₦15,000
        { memberId: m2.id, amount: 2000000 }, // ₦20,000
      ];

      const notifiedCount = await notifyMembersOfIngestedSchedule(
        coop.id,
        rows,
        "DED-OCT2026-X1",
        "ministry_payroll_oct.xlsx",
      );

      expect(notifiedCount).toBe(2);
      expect(notifyMember).toHaveBeenCalledTimes(2);

      const notifyCalls = vi.mocked(notifyMember).mock.calls;
      expect(notifyCalls[0][1]).toContain("Payroll Deduction Staged");
      expect(notifyCalls[0][1]).toContain("ministry_payroll_oct.xlsx");
      expect(notifyCalls[0][1]).toContain("DED-OCT2026-X1");
    });
  });

  describe("Feature 3: Thrift Collector / Field Agent Physical Cash Collection", () => {
    it("denies physical cash collection for unauthorized members", async () => {
      const coop = await makeCoop("Unauthorized Coop");
      const regularMember = await makeMember("2348044440001", coop.id, "Regular Joe", "member");
      const target = await makeMember("2348044440002", coop.id, "Target Joe", "member");

      const result = await collectCashDeposit(regularMember.phone, 5000, target.code);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Only authorized thrift collectors");
    });

    it("allows collector or admin to collect cash and credits member wallet immediately", async () => {
      const coop = await makeCoop("Thrift Field Coop");
      const collector = await makeMember("2348055550001", coop.id, "Agent Tunde", "collector");
      const trader = await makeMember("2348055550002", coop.id, "Mama Shade", "member", 100000); // ₦1,000 initial

      const result = await collectCashDeposit(
        collector.phone,
        3000, // ₦3,000 cash deposit
        trader.code,
        "Daily Bodija market collection",
      );

      expect(result.ok).toBe(true);
      expect(result.newBalance).toBe(400000); // ₦1,000 + ₦3,000 = ₦4,000
      expect(result.reference).toMatch(/^CASH-/);

      // Verify DB wallet update
      const updatedWallet = await prisma.wallet.findUnique({ where: { memberId: trader.id } });
      expect(updatedWallet?.balance).toBe(400000);
      expect(updatedWallet?.totalSaved).toBe(400000);

      // Verify contribution record created
      const contribution = await prisma.contribution.findFirst({
        where: { reference: result.reference },
      });
      expect(contribution).not.toBeNull();
      expect(contribution?.type).toBe("cash_collection");
      expect(contribution?.amount).toBe(300000);

      // Verify target received notification
      expect(notifyMember).toHaveBeenCalled();
      const notifyCall = vi
        .mocked(notifyMember)
        .mock.calls.find((c) => (c[1] as string).includes("Cash Deposit Received"));
      expect(notifyCall).toBeDefined();
      expect(notifyCall?.[1]).toContain("Agent Tunde");
      expect(notifyCall?.[1]).toContain(result.reference!);

      // Verify collector daily summary
      const summary = await getCollectorDailySummary(collector.phone);
      expect(summary).toContain("Today's Cash Collection Summary");
      expect(summary).toContain("Total Entries: *1*");
      expect(summary).toContain("Agent Tunde");
    });

    it("handles `collect` and `cashsummary` chat commands", async () => {
      const coop = await makeCoop("Chat Collect Coop");
      const collector = await makeMember("2348066660001", coop.id, "Alajo Collector", "collector");
      const member = await makeMember("2348066660002", coop.id, "Market Woman", "member", 50000);

      await handleMessage(collector.phone, `collect 2000 ${member.code} Ajo day 2`);

      expect(sendText).toHaveBeenCalled();
      const lastCall = vi.mocked(sendText).mock.calls.at(-1)?.[0];
      expect(lastCall?.text).toContain("Cash Collected & Credited");
      expect(lastCall?.text).toContain(member.name);

      // Check summary command
      await handleMessage(collector.phone, "cashsummary");

      const summaryCall = vi.mocked(sendText).mock.calls.at(-1)?.[0];
      expect(summaryCall?.text).toContain("Today's Cash Collection Summary");
    });
  });
});
