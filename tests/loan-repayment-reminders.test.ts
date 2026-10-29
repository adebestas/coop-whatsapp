import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "./setup.js";
import { notifyMember } from "../src/lib/messaging.js";
import { generateMemberCode, hashPin } from "../src/lib/security.js";
import { runLoanRepaymentReminders } from "../src/services/scheduler.js";

function uniqueCode(prefix: string) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

async function makeCoop(name = "Loan Reminder Coop") {
  return prisma.cooperative.create({ data: { name, code: uniqueCode("LRC"), adminPhone: null } });
}

async function makeMember(phone: string, coopId: string, name = "Test Member") {
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
      role: "member",
      pin: hashPin("1234"),
      consentAt: new Date(),
      wallet: { create: { balance: 5000000, totalSaved: 5000000 } },
    },
    include: { wallet: true },
  });
}

describe("Proactive Loan Repayment & Guarantor Early-Warning Alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends 7-day upcoming reminder to borrower", async () => {
    const coop = await makeCoop("7-Day Coop");
    const borrower = await makeMember("2348011220001", coop.id, "Borrower Seven");

    const now = new Date(2026, 9, 20); // Oct 20
    const dueDate = new Date(2026, 9, 27); // Oct 27 (7 days away)

    await prisma.loan.create({
      data: {
        cooperativeId: coop.id,
        memberId: borrower.id,
        amount: 5000000, // ₦50,000
        balance: 4000000,
        monthlyPayment: 1500000, // ₦15,000
        status: "disbursed",
        dueDate,
      },
    });

    const result = await runLoanRepaymentReminders(now, coop.id);
    expect(result.sevenDayCount).toBe(1);

    expect(notifyMember).toHaveBeenCalled();
    const calls = vi.mocked(notifyMember).mock.calls;
    const borrowerCall = calls.find((c) =>
      (c[1] as string).includes("Upcoming Loan Repayment Due"),
    );
    expect(borrowerCall).toBeDefined();
    expect(borrowerCall?.[1]).toContain("₦15,000.00");
    expect(borrowerCall?.[1]).toContain("7 days");
    expect(borrowerCall?.[1]).toContain("repay");
  });

  it("sends 1-day urgent reminder to borrower", async () => {
    const coop = await makeCoop("1-Day Coop");
    const borrower = await makeMember("2348011220002", coop.id, "Borrower OneDay");

    const now = new Date(2026, 9, 26); // Oct 26
    const dueDate = new Date(2026, 9, 27); // Oct 27 (1 day away)

    await prisma.loan.create({
      data: {
        cooperativeId: coop.id,
        memberId: borrower.id,
        amount: 6000000,
        balance: 6000000,
        monthlyPayment: 2000000,
        status: "disbursed",
        dueDate,
      },
    });

    const result = await runLoanRepaymentReminders(now, coop.id);
    expect(result.oneDayCount).toBe(1);

    expect(notifyMember).toHaveBeenCalled();
    const calls = vi.mocked(notifyMember).mock.calls;
    const call = calls.find((c) => (c[1] as string).includes("Loan Repayment Due Tomorrow"));
    expect(call).toBeDefined();
    expect(call?.[1]).toContain("₦20,000.00");
  });

  it("sends early overdue reminder to borrower ONLY at 3 days (guarantor is NOT notified yet)", async () => {
    const coop = await makeCoop("Early Overdue Coop");
    const borrower = await makeMember("2348011220003", coop.id, "Borrower EarlyLate");
    const guarantor = await makeMember("2348011220004", coop.id, "Guarantor Early");

    const now = new Date(2026, 9, 30); // Oct 30
    const dueDate = new Date(2026, 9, 27); // Oct 27 (3 days past due)

    const loan = await prisma.loan.create({
      data: {
        cooperativeId: coop.id,
        memberId: borrower.id,
        amount: 5000000,
        balance: 5000000,
        monthlyPayment: 1500000,
        status: "disbursed",
        dueDate,
      },
    });

    await prisma.guarantor.create({
      data: {
        code: uniqueCode("GE"),
        loanId: loan.id,
        memberId: guarantor.id,
        status: "confirmed",
        confirmedAt: new Date(),
      },
    });

    const result = await runLoanRepaymentReminders(now, coop.id);
    expect(result.borrowerOverdueCount).toBe(1);
    expect(result.guarantorOverdueCount).toBe(0);

    // Borrower was notified
    const calls = vi.mocked(notifyMember).mock.calls;
    const borrowerCall = calls.find((c) =>
      (c[1] as string).includes("Overdue Loan Repayment Notice"),
    );
    expect(borrowerCall).toBeDefined();

    // Guarantor was NOT notified at 3 days
    const guarantorCall = calls.find((c) => (c[1] as string).includes("Notice to Guarantor"));
    expect(guarantorCall).toBeUndefined();
  });

  it("escalates to notify guarantors AFTER 15 days overdue", async () => {
    const coop = await makeCoop("15-Day Overdue Coop");
    const borrower = await makeMember("2348011220005", coop.id, "Borrower 15DaysLate");
    const guarantor1 = await makeMember("2348011220006", coop.id, "Guarantor Alpha");
    const guarantor2 = await makeMember("2348011220007", coop.id, "Guarantor Beta");

    const now = new Date(2026, 10, 12); // Nov 12
    const dueDate = new Date(2026, 9, 27); // Oct 27 (16 days past due)

    const loan = await prisma.loan.create({
      data: {
        cooperativeId: coop.id,
        memberId: borrower.id,
        amount: 10000000,
        balance: 8000000,
        monthlyPayment: 2500000,
        status: "disbursed",
        dueDate,
      },
    });

    await prisma.guarantor.createMany({
      data: [
        {
          code: uniqueCode("G15A"),
          loanId: loan.id,
          memberId: guarantor1.id,
          status: "confirmed",
          confirmedAt: new Date(),
        },
        {
          code: uniqueCode("G15B"),
          loanId: loan.id,
          memberId: guarantor2.id,
          status: "confirmed",
          confirmedAt: new Date(),
        },
      ],
    });

    const result = await runLoanRepaymentReminders(now, coop.id);
    expect(result.guarantorOverdueCount).toBe(1);

    const calls = vi.mocked(notifyMember).mock.calls;

    // Both guarantors received escalation notice after 15 days
    const guarantorCalls = calls.filter((c) =>
      (c[1] as string).includes("Notice to Guarantor: Loan 15+ Days Overdue"),
    );
    expect(guarantorCalls.length).toBe(2);
    expect(guarantorCalls[0][1]).toContain("Borrower 15DaysLate");
    expect(guarantorCalls[0][1]).toContain("₦25,000.00");
    expect(guarantorCalls[0][1]).toContain("16 days overdue");
  });

  it("is idempotent: subsequent runs on same day do not double-notify", async () => {
    const coop = await makeCoop("Idempotent Coop");
    const borrower = await makeMember("2348011220008", coop.id, "Borrower Double");

    const now = new Date(2026, 9, 20);
    const dueDate = new Date(2026, 9, 27);

    await prisma.loan.create({
      data: {
        cooperativeId: coop.id,
        memberId: borrower.id,
        amount: 4000000,
        balance: 4000000,
        monthlyPayment: 1000000,
        status: "disbursed",
        dueDate,
      },
    });

    const firstRun = await runLoanRepaymentReminders(now, coop.id);
    expect(firstRun.sevenDayCount).toBe(1);

    // Second run immediately
    const secondRun = await runLoanRepaymentReminders(now, coop.id);
    expect(secondRun.sevenDayCount).toBe(0);
  });
});
