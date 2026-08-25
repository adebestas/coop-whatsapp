import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { disburseLoan } from "./disbursements.js";
import { requiredGuarantors } from "./guarantors.js";
import { audit } from "./audit.js";
import { recordLedger } from "./ledger.js";
import { LIMITS } from "../lib/money.js";
import { flagTransaction } from "./aml.js";
import { getCoopConfig } from "./coop-config.js";

/** After a loan leaves the queue, renumber positions for remaining pending loans. */
async function renumberQueue(cooperativeId: string): Promise<void> {
  const pending = await prisma.loan.findMany({
    where: {
      cooperativeId,
      status: { in: ["pending", "guaranteed", "admin_approved", "super_approved_1"] },
      queuePosition: { not: null },
    },
    orderBy: { queueJoinedAt: "asc" },
  });

  const updates = pending.map((loan, idx) =>
    prisma.loan.update({
      where: { id: loan.id },
      data: { queuePosition: idx + 1 },
    }),
  );
  await Promise.all(updates);
}

export interface ApplyLoanResult {
  ok: boolean;
  message: string;
  loanId?: string;
}

/** A loan can never exceed this multiple of the borrower's total savings. */
export const LOAN_TO_SAVINGS_RATIO = 2;
/** Flat admin charge deducted from every loan at disbursement (₦2,000 in kobo). */
export const LOAN_ADMIN_CHARGE = 200000;

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

/** Total repayable for a flat-rate loan: principal + flat interest (kobo integers). */
export function totalRepayable(amount: number, ratePercent: number): number {
  return Math.round(amount * (1 + ratePercent / 100));
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
  if (amount < LIMITS.MIN_LOAN) {
    return { ok: false, message: `Minimum loan amount is *${formatBalance(LIMITS.MIN_LOAN)}*.` };
  }
  if (amount > LIMITS.MAX_LOAN) {
    return { ok: false, message: `Maximum loan amount is *${formatBalance(LIMITS.MAX_LOAN)}*.` };
  }

  // Rule: a loan can't exceed 2x the member's total savings.
  const savings = member.wallet?.totalSaved ?? 0;
  const coopConfig = await getCoopConfig(member.cooperativeId);
  const loanMultiplier = coopConfig.maxLoanMultiplier;
  const maxLoan = Math.floor(savings * loanMultiplier);
  if (maxLoan <= 0) {
    return {
      ok: false,
      message: `Loans are capped at *${loanMultiplier}x your savings* and you have no savings yet. Save first — reply *save <amount>*.`,
    };
  }
  if (amount > maxLoan) {
    return {
      ok: false,
      message:
        `Loans are capped at *${loanMultiplier}x your savings*.\n` +
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
  const monthly = Math.floor(total / tenureMonths);

  // Assign queue position: count existing pending loans in this cooperative + 1
  const pendingCount = await prisma.loan.count({
    where: {
      cooperativeId: member.cooperativeId,
      status: { in: ["pending", "guaranteed", "admin_approved", "super_approved_1"] },
    },
  });

  const loan = await prisma.loan.create({
    data: {
      amount,
      adminCharge: LOAN_ADMIN_CHARGE,
      interestRate,
      tenureMonths,
      status: "pending",
      balance: amount,
      memberId: member.id,
      cooperativeId: member.cooperativeId,
      bankAccountNumber: bank?.accountNumber,
      bankCode: bank?.bankCode,
      bankName: bank?.bankName,
      queuePosition: pendingCount + 1,
      queueJoinedAt: new Date(),
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
  // Try exact match first
  const exact = await prisma.loan.findUnique({
    where: { id: shortId },
    include: { member: true, guarantors: { include: { member: true } } },
  });
  if (exact) return exact;

  // Try suffix match — require exactly one result
  const matches = await prisma.loan.findMany({
    where: { id: { endsWith: shortId } },
    include: { member: true, guarantors: { include: { member: true } } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
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

  // AML check: flag if member has suspicious recent transactions
  const amlResult = await flagTransaction({
    memberId: loan.memberId,
    cooperativeId: loan.cooperativeId,
    amount: loan.amount,
    type: "loan_disbursement",
    direction: "out",
  });

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

  // Cooperative Societies Act: minimum 20 active members before disbursing loans
  const memberCount = await prisma.member.count({ where: { cooperativeId: loan.cooperativeId, status: "active" } });
  if (memberCount < 20) {
    return { ok: false, message: "Cooperative must have at least 20 active members before disbursing loans (Cooperative Societies Act)." };
  }

  const total = totalRepayable(loan.amount, loan.interestRate);
  const monthly = Math.floor(total / loan.tenureMonths);
  const due = new Date();
  due.setMonth(due.getMonth() + 1);

  // ATOMIC CLAIM — the second concurrent finalizer gets count=0 and stops.
  const claimed = await prisma.loan.updateMany({
    where: { id: loan.id, status: "super_approved_1" },
    data: {
      status: "approved",
      monthlyPayment: monthly,
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

  // AML check on final approval
  const amlCheck = await flagTransaction({
    memberId: loan.memberId,
    cooperativeId: loan.cooperativeId,
    amount: loan.amount,
    type: "loan_disbursement",
    direction: "out",
  });
  const amlNote = amlCheck.flagged
    ? `\n\n⚠️ *AML Alert*: ${amlCheck.reasons.join("; ")}`
    : "";

  // Clear queue position and renumber remaining loans
  await prisma.loan.update({
    where: { id: loan.id },
    data: { queuePosition: null, queueJoinedAt: null },
  });
  await renumberQueue(loan.cooperativeId);

  // Auto-disburse to the member's bank account (name-verified by the provider).
  const disbursement = await disburseLoan(loan.id);
  return { ok: true, message: `${approvedMsg}${amlNote}\n\n${disbursement.message}` };
}

export async function rejectLoan(loanId: string): Promise<{ ok: boolean; message: string }> {
  const loan = await findLoan(loanId);
  if (!loan) return { ok: false, message: "Loan not found. Check the id and try again." };
  if (!["pending", "guaranteed", "admin_approved", "super_approved_1"].includes(loan.status)) {
    return { ok: false, message: `Loan is already ${loan.status}.` };
  }

  await prisma.loan.update({ where: { id: loan.id }, data: { status: "rejected", queuePosition: null, queueJoinedAt: null } });
  await renumberQueue(loan.cooperativeId);
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

  // Late fine: lateFinePercent% of the installment per month overdue.
  let fine = 0;
  const now = Date.now();
  if (loan.dueDate && loan.dueDate.getTime() < now) {
    const coopConfig = await getCoopConfig(member.cooperativeId);
    const fineRate = coopConfig.lateFinePercent;
    const monthsLate = Math.max(
      1,
      Math.floor((now - loan.dueDate.getTime()) / (30 * 24 * 60 * 60 * 1000)),
    );
    fine = Math.round(amount * (fineRate / 100) * monthsLate);
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

  // All operations in one transaction for atomicity
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
  const interestPortion = Math.floor(totalInterest / loan.tenureMonths);
  await recordLedger({
    cooperativeId: member.cooperativeId,
    type: "income",
    category: "interest",
    amount: interestPortion,
    note: `Installment interest on loan ${loan.id.slice(-6)}`,
    reference: loan.id,
    fundType: "member",
  });
  if (fine > 0) {
    await recordLedger({
      cooperativeId: member.cooperativeId,
      type: "income",
      category: "fine",
      amount: fine,
      note: `Late fine on loan ${loan.id.slice(-6)}`,
      reference: loan.id,
      fundType: "member",
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

/**
 * Get a member's queue position for their pending loan.
 * Returns position, total queue size, and estimated wait time.
 */
export async function getQueuePosition(
  memberId: string,
): Promise<{ position: number; total: number; estimatedWait: string } | null> {
  const loan = await prisma.loan.findFirst({
    where: { memberId, status: { in: ["pending", "guaranteed", "admin_approved", "super_approved_1"] } },
    orderBy: { queueJoinedAt: "asc" },
  });
  if (!loan) return null;

  const total = await prisma.loan.count({
    where: {
      cooperativeId: loan.cooperativeId,
      status: { in: ["pending", "guaranteed", "admin_approved", "super_approved_1"] },
    },
  });

  const position = loan.queuePosition ?? 1;

  // Calculate estimated wait based on average disbursement rate this month
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const disbursedThisMonth = await prisma.loan.count({
    where: {
      cooperativeId: loan.cooperativeId,
      status: { in: ["approved", "disbursed"] },
      approvedAt: { gte: startOfMonth },
    },
  });

  const daysElapsed = Math.max(1, Math.floor((Date.now() - startOfMonth.getTime()) / (24 * 60 * 60 * 1000)));
  const dailyRate = disbursedThisMonth / daysElapsed;

  let estimatedWait: string;
  if (dailyRate <= 0) {
    estimatedWait = "unknown (no loans disbursed this month)";
  } else {
    const daysAhead = position - 1; // loans ahead in queue
    const estimatedDays = Math.ceil(daysAhead / dailyRate);
    if (estimatedDays <= 0) {
      estimatedWait = "~1 day";
    } else if (estimatedDays === 1) {
      estimatedWait = "~1 day";
    } else {
      estimatedWait = `~${estimatedDays} days`;
    }
  }

  return { position, total, estimatedWait };
}