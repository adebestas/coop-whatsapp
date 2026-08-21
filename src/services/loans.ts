import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { disburseLoan } from "./disbursements.js";
import { requiredGuarantors } from "./guarantors.js";
import { audit } from "./audit.js";
import { recordLedger } from "./ledger.js";

export interface ApplyLoanResult {
  ok: boolean;
  message: string;
  loanId?: string;
}

/** A loan can never exceed this multiple of the borrower's total savings. */
export const LOAN_TO_SAVINGS_RATIO = 2;
/** Flat fine (% of the late installment) charged per month overdue. */
export const LATE_FINE_RATE = 2;
/** Flat admin charge deducted from every loan at disbursement. */
export const LOAN_ADMIN_CHARGE = 2000;

/**
 * Tiered flat interest on the principal (not per month):
 * up to 3 months → 5%, up to 6 → 8%, up to 9 → 9%, longer → 10%.
 */
export function interestRateFor(tenureMonths: number): number {
  if (tenureMonths <= 3) return 5;
  if (tenureMonths <= 6) return 8;
  if (tenureMonths <= 9) return 9;
  return 10;
}

/** Total repayable for a flat-rate loan: principal + flat interest. */
export function totalRepayable(amount: number, ratePercent: number): number {
  return Math.round(amount * (1 + ratePercent / 100) * 100) / 100;
}

/**
 * Apply for a loan. Amount + tenure months come from the chat.
 * Nigeria-coop rules: max 2x savings, no new loans while defaulting.
 */
export async function applyForLoan(
  phone: string,
  amount: number,
  tenureMonths: number,
  bank?: { accountNumber: string; bankCode: string; bankName?: string },
): Promise<ApplyLoanResult> {
  const member = await prisma.member.findFirst({
    where: { phone },
    include: { cooperative: true, wallet: true },
  });
  if (!member) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };
  }
  if (!Number.isFinite(amount) || amount <= 0 || tenureMonths < 1 || tenureMonths > 12) {
    return { ok: false, message: "Use the format *loan <amount> <months>*, e.g. *loan 50000 3* (up to 12 months)." };
  }

  // Rule: a loan can't exceed 2x the member's total savings.
  const savings = member.wallet?.totalSaved ?? 0;
  const maxLoan = Math.floor(savings * LOAN_TO_SAVINGS_RATIO);
  if (maxLoan <= 0) {
    return {
      ok: false,
      message: `Loans are capped at *${LOAN_TO_SAVINGS_RATIO}x your savings* and you have no savings yet. Save first — reply *save <amount>*.`,
    };
  }
  if (amount > maxLoan) {
    return {
      ok: false,
      message:
        `Loans are capped at *${LOAN_TO_SAVINGS_RATIO}x your savings*.\n` +
        `Your savings: ${formatBalance(savings)} → max loan: *${formatBalance(maxLoan)}*.\n` +
        `Try a smaller amount or save more first.`,
    };
  }

  // Rule: members who are behind on an existing loan can't take another one.
  const defaulted = await prisma.loan.findFirst({
    where: {
      memberId: member.id,
      status: { in: ["approved", "disbursed"] },
      balance: { gt: 0 },
      dueDate: { lt: new Date() },
    },
  });
  if (defaulted) {
    return {
      ok: false,
      message:
        `⛔ You're behind on loan *${defaulted.id.slice(-6)}* (due ${defaulted.dueDate?.toISOString().slice(0, 10)}). Clear it — reply *repay* — before applying again.`,
    };
  }

  // Interest is tiered by tenure and charged flat on the principal.
  const interestRate = interestRateFor(tenureMonths);
  const total = totalRepayable(amount, interestRate);
  const monthly = total / tenureMonths;

  const loan = await prisma.loan.create({
    data: {
      amount,
      interestRate,
      tenureMonths,
      status: "pending",
      balance: amount,
      memberId: member.id,
      cooperativeId: member.cooperativeId,
      bankAccountNumber: bank?.accountNumber,
      bankCode: bank?.bankCode,
      bankName: bank?.bankName,
    },
  });

  const needed = requiredGuarantors(member.role);

  return {
    ok: true,
    loanId: loan.id,
    message:
      `Loan application received ✅\n\n` +
      `Amount requested: *${formatBalance(amount)}*\n` +
      `Tenure: *${tenureMonths} months*\n` +
      `Interest: *${interestRate}% flat* → repay *${formatBalance(Math.round(total))}*\n` +
      `Monthly installment: *${formatBalance(Math.round(monthly))}*\n` +
      `Admin charge: *${formatBalance(LOAN_ADMIN_CHARGE)}* (you'll receive ${formatBalance(amount - LOAN_ADMIN_CHARGE)})\n\n` +
      `You still need to add *${needed} guarantor${needed > 1 ? "s" : ""}* before the loan can be approved.`,
  };
}

export async function listPendingLoans(cooperativeId: string, limit = 20) {
  return prisma.loan.findMany({
    where: {
      cooperativeId,
      status: { in: ["pending", "guaranteed", "admin_approved", "super_approved_1"] },
    },
    include: {
      member: { select: { name: true, phone: true, unitId: true } },
      guarantors: { include: { member: { select: { name: true, phone: true } } } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/** Resolve a full loan id from a short (suffix) id shown in chat. */
async function findLoan(shortId: string) {
  return prisma.loan.findFirst({
    where: {
      OR: [
        { id: shortId },
        { id: { startsWith: shortId } },
        { id: { endsWith: shortId } },
      ],
    },
    include: { member: true, guarantors: { include: { member: true } } },
  });
}

/**
 * Three-step approval:
 *   1. admin (or super) → `admin_approved`
 *   2. first super admin → `super_approved_1`
 *   3. a *different* super admin → `approved` → auto-disbursement
 */
export async function approveLoan(
  loanId: string,
  opts: { superAdmin?: boolean; actorId?: string } = {},
): Promise<{ ok: boolean; message: string }> {
  const loan = await findLoan(loanId);
  if (!loan) return { ok: false, message: "Loan not found. Check the id and try again." };
  const shortId = loan.id.slice(-6);

  // Dual-control: nobody approves their own borrowing.
  if (opts.actorId && loan.memberId === opts.actorId) {
    return {
      ok: false,
      message: `⛔ You can't approve your own loan. Another admin/super admin must do that.`,
    };
  }

  if (loan.status === "super_approved_1") {
    if (!opts.superAdmin) {
      return {
        ok: false,
        message: `Loan *${shortId}* needs a *second super admin* to approve before disbursement.`,
      };
    }
    if (opts.actorId && loan.finalApprovedById === opts.actorId) {
      return {
        ok: false,
        message: `⛔ You already approved this loan. A *different* super admin must give the second approval.`,
      };
    }
    return finalizeLoanApproval(loan.id, opts.actorId);
  }

  if (loan.status === "admin_approved") {
    if (!opts.superAdmin) {
      return {
        ok: false,
        message: `Loan *${shortId}* is waiting for the *first super admin's* approval.`,
      };
    }
    // Atomic transition — two supers approving simultaneously: only ONE wins
    // this step (the row no longer matches WHERE status='admin_approved').
    const moved = await prisma.loan.updateMany({
      where: { id: loan.id, status: "admin_approved" },
      data: { status: "super_approved_1", finalApprovedById: opts.actorId, approvedAt: new Date() },
    });
    if (moved.count === 0) {
      return { ok: false, message: `Loan *${shortId}* was just updated by another approval. Check *pending*.` };
    }
    return {
      ok: true,
      message:
        `First super approval recorded for loan *${shortId}* (${loan.member.name}). ` +
        `One *more* super admin must reply *approve ${shortId}* to release the money.`,
    };
  }

  if (loan.status !== "guaranteed") {
    const needed = requiredGuarantors(loan.member.role);
    return {
      ok: false,
      message: `Loan *${shortId}* can't be approved yet. It must have ${needed} confirmed guarantor(s) (current status: ${loan.status}).`,
    };
  }

  // Step 1 — admin approval. A super admin's first signature already counts
  // as the first *super* approval (they outrank the admin step).
  if (opts.superAdmin) {
    const moved = await prisma.loan.updateMany({
      where: { id: loan.id, status: "guaranteed" },
      data: { status: "super_approved_1", finalApprovedById: opts.actorId },
    });
    if (moved.count === 0) {
      return { ok: false, message: `Loan *${shortId}* was just updated by another approval. Check *pending*.` };
    }
    return {
      ok: true,
      message:
        `First super approval recorded for loan *${shortId}* (${loan.member.name}). ` +
        `One *more* super admin must reply *approve ${shortId}* to release the money.`,
    };
  }
  const movedAdmin = await prisma.loan.updateMany({
    where: { id: loan.id, status: "guaranteed" },
    data: { status: "admin_approved", adminApprovedById: opts.actorId },
  });
  if (movedAdmin.count === 0) {
    return { ok: false, message: `Loan *${shortId}* was just updated by another approval. Check *pending*.` };
  }
  return {
    ok: true,
    message: `Loan *${shortId}* for ${loan.member.name} approved by admin. A *super admin* must reply *approve ${shortId}* next (two super approvals release the money).`,
  };
}

/**
 * Second (final) super approval — sets terms, marks approved, disburses.
 * The status flip happens as an atomic CLAIM: exactly one concurrent caller
 * can move super_approved_1 -> approved, so the loan can never be disbursed
 * twice even under racing approvals.
 */
async function finalizeLoanApproval(loanId: string, actorId?: string): Promise<{ ok: boolean; message: string }> {
  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { member: true },
  });
  if (!loan || loan.status !== "super_approved_1") {
    return { ok: false, message: "Loan isn't ready for final approval." };
  }

  const total = totalRepayable(loan.amount, loan.interestRate);
  const monthly = total / loan.tenureMonths;
  const due = new Date();
  due.setMonth(due.getMonth() + 1);

  // ATOMIC CLAIM — the second concurrent finalizer gets count=0 and stops.
  const claimed = await prisma.loan.updateMany({
    where: { id: loan.id, status: "super_approved_1" },
    data: {
      status: "approved",
      monthlyPayment: Math.round(monthly * 100) / 100,
      balance: total,
      superApproved2ById: actorId,
      approvedAt: new Date(),
      dueDate: due,
    },
  });
  if (claimed.count === 0) {
    return {
      ok: false,
      message: `Loan *${loan.id.slice(-6)}* was already finalized by another super admin moments ago.`,
    };
  }

  const approvedMsg =
    `Loan *${loan.id.slice(-6)}* fully approved for ${loan.member.name}: ${formatBalance(loan.amount)} @ ${loan.interestRate}% flat for ${loan.tenureMonths} months. Monthly: ${formatBalance(Math.round(monthly))}.`;

  // Auto-disburse to the member's bank account (name-verified by the provider).
  const disbursement = await disburseLoan(loan.id);
  return { ok: true, message: `${approvedMsg}\n\n${disbursement.message}` };
}

export async function rejectLoan(loanId: string): Promise<{ ok: boolean; message: string }> {
  const loan = await findLoan(loanId);
  if (!loan) return { ok: false, message: "Loan not found. Check the id and try again." };
  if (!["pending", "guaranteed", "admin_approved", "super_approved_1"].includes(loan.status)) {
    return { ok: false, message: `Loan is already ${loan.status}.` };
  }

  await prisma.loan.update({ where: { id: loan.id }, data: { status: "rejected" } });
  return { ok: true, message: `Loan *${loan.id.slice(-6)}* for ${loan.member.name} was rejected.` };
}

/**
 * Member repays their loan monthly installment. Debited from wallet.
 */
export async function repayLoan(phone: string, loanId?: string): Promise<{ ok: boolean; message: string }> {
  const member = await prisma.member.findFirst({
    where: { phone },
    include: { wallet: true },
  });
  if (!member || !member.wallet) {
    return { ok: false, message: "No wallet found. Join a cooperative first." };
  }

  const loan = loanId
    ? await prisma.loan.findUnique({ where: { id: loanId } })
    : await prisma.loan.findFirst({
        where: { memberId: member.id, status: { in: ["approved", "disbursed"] } },
        orderBy: { dueDate: "asc" },
      });

  if (!loan) {
    return { ok: false, message: "You have no active loan to repay." };
  }
  const amount = loan.monthlyPayment ?? loan.balance;

  // Late fine: LATE_FINE_RATE% of the installment per month overdue.
  let fine = 0;
  const now = Date.now();
  if (loan.dueDate && loan.dueDate.getTime() < now) {
    const monthsLate = Math.max(
      1,
      Math.floor((now - loan.dueDate.getTime()) / (30 * 24 * 60 * 60 * 1000)),
    );
    fine = Math.round(amount * (LATE_FINE_RATE / 100) * monthsLate);
  }
  const totalDue = amount + fine;

  if (member.wallet.balance < totalDue) {
    return {
      ok: false,
      message:
        `Your wallet balance (${formatBalance(member.wallet.balance)}) is less than the installment (${formatBalance(amount)})` +
        (fine > 0 ? ` plus a *${formatBalance(fine)} late fine*` : "") +
        `. Reply *fund* to top up first.`,
    };
  }

  // Atomic debit: only succeeds if the balance still covers the total due.
  const debited = await prisma.wallet.updateMany({
    where: { id: member.wallet.id, balance: { gte: totalDue } },
    data: { balance: { decrement: totalDue } },
  });
  if (debited.count === 0) {
    return { ok: false, message: "Your wallet balance changed — please try again." };
  }

  await prisma.$transaction([
    prisma.loan.update({
      where: { id: loan.id },
      data: { balance: { decrement: amount } },
    }),
    prisma.loanRepayment.create({
      data: { loanId: loan.id, amount },
    }),
    // Fines go to the cooperative pot as a confirmed contribution.
    ...(fine > 0
      ? [
          prisma.contribution.create({
            data: {
              memberId: member.id,
              cooperativeId: member.cooperativeId,
              type: "fine",
              amount: fine,
              status: "confirmed",
              reference: `FINE-${loan.id.slice(-6)}-${Date.now()}`,
              note: `Late fine on loan ${loan.id.slice(-6)}`,
            },
          }),
        ]
      : []),
  ]);

  // P&L: the interest slice of this installment is cooperative income; fines too.
  const totalInterest = totalRepayable(loan.amount, loan.interestRate) - loan.amount;
  const interestPortion = Math.round((totalInterest / loan.tenureMonths) * 100) / 100;
  await recordLedger({
    cooperativeId: member.cooperativeId,
    type: "income",
    category: "interest",
    amount: interestPortion,
    note: `Installment interest on loan ${loan.id.slice(-6)}`,
    reference: loan.id,
  });
  if (fine > 0) {
    await recordLedger({
      cooperativeId: member.cooperativeId,
      type: "income",
      category: "fine",
      amount: fine,
      note: `Late fine on loan ${loan.id.slice(-6)}`,
      reference: loan.id,
    });
  }

  const updated = await prisma.loan.findUnique({ where: { id: loan.id } });
  const isPaid = (updated?.balance ?? 0) <= 0;
  if (isPaid) {
    await prisma.loan.update({ where: { id: loan.id }, data: { status: "paid" } });
  } else if (updated?.dueDate) {
    const next = new Date(updated.dueDate);
    next.setMonth(next.getMonth() + 1);
    await prisma.loan.update({ where: { id: loan.id }, data: { dueDate: next } });
  }

  await audit({
    cooperativeId: member.cooperativeId,
    actorPhone: phone,
    actorId: member.id,
    actorRole: member.role,
    action: "loan.repay",
    targetType: "loan",
    targetId: loan.id,
    detail: `${formatBalance(amount)}${fine > 0 ? ` + ${formatBalance(fine)} fine` : ""}`,
  });

  return {
    ok: true,
    message:
      `✅ Repaid ${formatBalance(amount)} on loan *${loan.id.slice(-6)}*.` +
      (fine > 0 ? `\n⚠️ A *${formatBalance(fine)} late fine* was also deducted.` : "") +
      (isPaid
        ? " This loan is now fully paid 🎉"
        : ` Remaining balance: ${formatBalance(updated?.balance ?? 0)}.`),
  };
}