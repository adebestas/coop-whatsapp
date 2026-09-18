import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";
import { disburseLoan } from "./disbursements.js";
import { requiredGuarantors } from "./guarantors.js";
import { audit } from "./audit.js";
import { recordLedger } from "./ledger.js";
import { LIMITS } from "../lib/money.js";
import { flagTransaction } from "./aml.js";
import { getCoopConfig } from "./coop-config.js";
import { sendText } from "../lib/messaging.js";

/** After a loan leaves the queue, renumber positions for remaining pending loans. */
async function renumberQueue(cooperativeId: string): Promise<void> {
  const pending = await prisma.loan.findMany({
    where: {
      cooperativeId,
      status: { in: ["pending", "guaranteed", "account_officer_approved", "admin_approved", "super_approved_1"] },
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

/**
 * Get a member's role by their ID.
 */
async function getMemberRole(memberId: string): Promise<string> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { role: true },
  });
  return member?.role ?? "member";
}

export interface ApplyLoanResult {
  ok: boolean;
  message: string;
  loanId?: string;
}

/** A loan can never exceed this multiple of the borrower's total savings. */
export const LOAN_TO_SAVINGS_RATIO = Number(process.env.LOAN_TO_SAVINGS_RATIO ?? "2");
/** Flat admin charge deducted from every loan at disbursement (₦2,000 in kobo). */
export const LOAN_ADMIN_CHARGE = Number(process.env.LOAN_ADMIN_CHARGE ?? "200000");
/** Maximum allowed interest rate per CBN guidance on cooperative lending. */
const MAX_ALLOWED_RATE = 15; // 15% max per CBN guidance

/**
 * Annual interest rates by tenure tier (declining balance / reducing balance).
 * These are annual percentage rates (APR) applied monthly on declining balance.
 */
const ANNUAL_RATE_BY_TENURE: Record<string, number> = {
  "1-3": 20.0,   // ~5% flat equivalent over 3 months
  "4-6": 16.0,   // ~8% flat equivalent over 6 months
  "7-9": 12.0,   // ~9% flat equivalent over 9 months
  "10-12": 10.0, // ~10% flat equivalent over 12 months
};

/**
 * Get the annual interest rate (APR) for a given tenure.
 * Returns the annual percentage rate for declining balance calculation.
 */
export function annualRateFor(tenureMonths: number): number {
  if (tenureMonths <= 3) return ANNUAL_RATE_BY_TENURE["1-3"];
  if (tenureMonths <= 6) return ANNUAL_RATE_BY_TENURE["4-6"];
  if (tenureMonths <= 9) return ANNUAL_RATE_BY_TENURE["7-9"];
  return ANNUAL_RATE_BY_TENURE["10-12"];
}

/**
 * Get the monthly interest rate (as decimal) for declining balance calculation.
 */
export function monthlyRateFor(tenureMonths: number): number {
  return annualRateFor(tenureMonths) / 100 / 12;
}

/**
 * Calculate monthly payment for a declining balance (reducing balance) loan.
 * Formula: P * r / (1 - (1 + r)^-n)
 * where P = principal, r = monthly rate (decimal), n = number of months
 */
export function calculateMonthlyPayment(principal: number, tenureMonths: number): number {
  const r = monthlyRateFor(tenureMonths);
  if (r === 0) return Math.round(principal / tenureMonths);
  const n = tenureMonths;
  const monthlyPayment = principal * r / (1 - Math.pow(1 + r, -n));
  return Math.round(monthlyPayment);
}

/** Total repayable for a declining balance loan: monthly payment * tenure (kobo integers). */
export function totalRepayable(amount: number, tenureMonths: number): number {
  return calculateMonthlyPayment(amount, tenureMonths) * tenureMonths;
}

/** Calculate interest portion of a specific installment for declining balance loan. */
export function calculateInterestPortion(remainingBalance: number, tenureMonths: number): number {
  const r = monthlyRateFor(tenureMonths);
  return Math.floor(remainingBalance * r);
}

/** Calculate principal portion of a specific installment for declining balance loan. */
export function calculatePrincipalPortion(installmentAmount: number, remainingBalance: number, tenureMonths: number): number {
  const interestPortion = calculateInterestPortion(remainingBalance, tenureMonths);
  return Math.max(0, installmentAmount - interestPortion);
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
  const loanMultiplier = LOAN_TO_SAVINGS_RATIO;
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

  // Interest is tiered by tenure and charged on declining balance (reducing balance).
  const interestRate = annualRateFor(tenureMonths);
  const monthly = calculateMonthlyPayment(amount, tenureMonths);
  const total = totalRepayable(amount, tenureMonths);

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
      `Interest: *${annualRateFor(tenureMonths)}% APR* declining balance → repay *${formatBalance(Math.round(total))}*\n` +
      `Monthly installment: *${formatBalance(Math.round(monthly))}*\n` +
      `Admin charge: *${formatBalance(LOAN_ADMIN_CHARGE)}* (you'll receive ${formatBalance(amount - LOAN_ADMIN_CHARGE)})\n\n` +
      `You still need to add *${needed} guarantor${needed > 1 ? "s" : ""}* before the loan can be approved.`,
  };
}

export async function listPendingLoans(cooperativeId: string, limit = 20, unitId?: string) {
  return prisma.loan.findMany({
    where: {
      cooperativeId,
      status: { in: ["pending", "guaranteed", "admin_approved", "super_approved_1"] },
      ...(unitId ? { member: { unitId } } : {}),
    },
    include: {
      member: { select: { name: true, phone: true, unitId: true } },
      guarantors: { include: { member: { select: { name: true, phone: true } } } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/** Resolve a full loan id from a short (suffix) id shown in chat, scoped to a cooperative. */
async function findLoan(shortId: string, cooperativeId: string) {
  // Try exact match first
  const exact = await prisma.loan.findUnique({
    where: { id: shortId, cooperativeId },
    include: { member: true, guarantors: { include: { member: true } } },
  });
  if (exact) return exact;

  // Try suffix match — require exactly one result
  const matches = await prisma.loan.findMany({
    where: { id: { endsWith: shortId }, cooperativeId },
    include: { member: true, guarantors: { include: { member: true } } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Step 1: Account Officer approval — first line of review.
 * Only Account Officers assigned to the cooperative can approve.
 * This is a first-line gate before admin/super approvals.
 */
export async function approveLoanByAccountOfficer(
  loanId: string,
  opts: { actorId: string; cooperativeId: string },
): Promise<{ ok: boolean; message: string }> {
  const loan = await findLoan(loanId, opts.cooperativeId);
  if (!loan) return { ok: false, message: "Loan not found. Check the id and try again." };
  const shortId = loan.id.slice(-6);

  // Dual-control: nobody approves their own borrowing.
  if (opts.actorId && loan.memberId === opts.actorId) {
    return {
      ok: false,
      message: `⛔ You can't approve your own loan. Another Account Officer must do that.`,
    };
  }

  if (loan.status !== "guaranteed") {
    const needed = requiredGuarantors(await getMemberRole(loan.memberId));
    return {
      ok: false,
      message: `Loan *${shortId}* can't be approved yet. It must have ${needed} confirmed guarantor(s) (current status: ${loan.status}).`,
    };
  }

  // Verify the actor is an active Account Officer assigned to this cooperative
  const assignment = await prisma.accountOfficerAssignment.findUnique({
    where: {
      accountOfficerId_cooperativeId: {
        accountOfficerId: opts.actorId,
        cooperativeId: opts.cooperativeId,
      },
    },
  });
  if (!assignment || !assignment.isActive) {
    return {
      ok: false,
      message: `You are not assigned as an Account Officer for this cooperative. Contact a super admin to be assigned.`,
    };
  }

  // Check if the officer is also the borrower
  if (loan.memberId === opts.actorId) {
    return {
      ok: false,
      message: `⛔ You cannot approve your own loan application. Another Account Officer must review it.`,
    };
  }

  // Atomic transition — only succeeds if status is still "guaranteed"
  const claimed = await prisma.loan.updateMany({
    where: { id: loan.id, status: "guaranteed" },
    data: {
      status: "account_officer_approved",
      accountOfficerApprovedById: opts.actorId,
      accountOfficerApprovedAt: new Date(),
    },
  });
  if (claimed.count === 0) {
    return {
      ok: false,
      message: `Loan *${shortId}* was just updated by another officer. Check *pending*.`,
    };
  }

  // Audit the approval
  await audit({
    cooperativeId: opts.cooperativeId,
    actorPhone: (await prisma.member.findUnique({ where: { id: opts.actorId } }))?.phone ?? opts.actorId,
    actorId: opts.actorId,
    actorRole: "account_officer",
    action: "loan.account_officer_approve",
    targetType: "loan",
    targetId: loan.id,
    detail: `Account Officer approved loan *${shortId}* for ${(await prisma.member.findUnique({ where: { id: loan.memberId } }))?.name ?? "member"}`,
  });

  return {
    ok: true,
    message: `Loan *${shortId}* for ${(await prisma.member.findUnique({ where: { id: loan.memberId } }))?.name ?? "member"} approved by Account Officer. Awaiting admin approval.`,
  };
}

/**
 * 5-Stage Loan Approval State Machine:
 * PENDING → GUARANTEED → ADMIN_APPROVED → SUPER_APPROVED_1 → APPROVED → DISBURSED
 * 
 * Rejection states (terminal, restart at PENDING on reapplication):
 * REJECTED_BY_GUARANTOR, REJECTED_BY_OFFICER, REJECTED_BY_SUPER_1, REJECTED_BY_SUPER_2
 * 
 * Enforcement rules:
 * - No stage can be skipped
 * - Same actorId cannot appear in two approval roles (Account Officer, Super Admin 1, Super Admin 2)
 * - Applicant cannot be guarantor or approver on their own loan
 * - Rejection at any stage is terminal (never falls through)
 * - Account Officer must be assigned to the loan's cooperative
 * - Disbursement only fires after APPROVED stage
 * - Reapplication after rejection restarts cleanly at PENDING
 */
export async function approveLoan(
  loanId: string,
  opts: { superAdmin?: boolean; isAdmin?: boolean; actorId?: string; cooperativeId: string },
): Promise<{ ok: boolean; message: string }> {
  const loan = await findLoan(loanId, opts.cooperativeId);
  if (!loan) return { ok: false, message: "Loan not found. Check the id and try again." };
  const shortId = loan.id.slice(-6);

  // Universal identity check: applicant cannot approve their own loan at ANY stage
  if (opts.actorId && loan.memberId === opts.actorId) {
    return {
      ok: false,
      message: `⛔ You cannot approve your own loan at any stage.`,
    };
  }

  // Check if this actor has already acted on this loan in an approval role
  const previousActorIds = [
    loan.accountOfficerApprovedById,
    loan.adminApprovedById,
    loan.finalApprovedById,
    loan.superApproved2ById,
  ].filter(Boolean);

  if (opts.actorId && previousActorIds.includes(opts.actorId)) {
    return {
      ok: false,
      message: `⛔ You have already acted on this loan in another approval role. The same person cannot fill multiple approval roles.`,
    };
  }

  // Check for super_approved_1 status (Stage 5 - second super admin approval)
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
        message: `⛔ You already approved this loan as the first super admin. A *different* super admin must give the second approval.`,
      };
    }
    return finalizeLoanApproval(loan.id, opts.actorId);
  }

  // Stage 4: SUPER_APPROVED_1 (first super admin approval)
  if (loan.status === "admin_approved") {
    if (!opts.superAdmin) {
      return {
        ok: false,
        message: `Loan *${shortId}* is waiting for the *first super admin's* approval.`,
      };
    }
    // Check if this super admin already acted as Account Officer or will be second super admin
    if (opts.actorId && (loan.accountOfficerApprovedById === opts.actorId || loan.finalApprovedById === opts.actorId)) {
      return {
        ok: false,
        message: `⛔ You have already acted on this loan in another role. The same person cannot fill multiple approval roles.`,
      };
    }
    // Atomic transition — two supers approving simultaneously: only ONE wins
    const moved = await prisma.loan.updateMany({
      where: { id: loan.id, status: "admin_approved" },
      data: { status: "super_approved_1", finalApprovedById: opts.actorId, approvedAt: new Date() },
    });
    if (moved.count === 0) {
      return { ok: false, message: `Loan *${shortId}* was just updated by another approval. Check *pending*.` };
    }
    // Notify applicant
    await notifyLoanStatusChange(loan, "super_approved_1");
    return {
      ok: true,
      message:
        `First super approval recorded for loan *${shortId}* (${loan.member.name}). ` +
        `One *more* super admin must reply *approve ${shortId}* to release the money.`,
    };
  }

  // Stage 3: ADMIN_APPROVED (Account Officer review)
  if (loan.status === "account_officer_approved") {
    if (!opts.superAdmin && !opts.isAdmin) {
      return {
        ok: false,
        message: `Loan *${shortId}* is waiting for an *admin's* approval after Account Officer review.`,
      };
    }
    // Check if this admin already acted as Account Officer
    if (opts.actorId && loan.accountOfficerApprovedById === opts.actorId) {
      return {
        ok: false,
        message: `⛔ You already approved this loan as the Account Officer. You cannot also approve it as admin.`,
      };
    }
    const movedAdmin = await prisma.loan.updateMany({
      where: { id: loan.id, status: "account_officer_approved" },
      data: { status: "admin_approved", adminApprovedById: opts.actorId },
    });
    if (movedAdmin.count === 0) {
      return { ok: false, message: `Loan *${shortId}* was just updated by another approval. Check *pending*.` };
    }
    // Audit log
    const adminActor = await prisma.member.findUnique({ where: { id: opts.actorId } });
    await audit({
      cooperativeId: opts.cooperativeId,
      actorPhone: adminActor?.phone ?? opts.actorId ?? "unknown",
      actorId: opts.actorId,
      actorRole: "admin",
      action: "loan.admin_approve",
      targetType: "loan",
      targetId: loan.id,
      detail: `Admin approved loan *${shortId}* for ${loan.member.name} after Account Officer review`,
    });
    // Notify applicant
    await notifyLoanStatusChange(loan, "admin_approved");
    // Notify next required approver (Super Admin 1)
    await notifyNextApprover(loan, "super_approved_1");
    return {
      ok: true,
      message: `Loan *${shortId}* for ${loan.member.name} approved by admin. A *super admin* must reply *approve ${shortId}* next.`,
    };
  }

  // Stage 2: GUARANTEED → needs Account Officer approval
  if (loan.status === "guaranteed") {
    if (!opts.isAdmin && !opts.superAdmin) {
      return {
        ok: false,
        message: `Loan *${shortId}* requires an Account Officer (admin) to review it first.`,
      };
    }
    // Check if actor is an active Account Officer for this cooperative
    const assignment = await prisma.accountOfficerAssignment.findUnique({
      where: {
        accountOfficerId_cooperativeId: {
          accountOfficerId: opts.actorId!,
          cooperativeId: opts.cooperativeId,
        },
      },
    });
    if (!assignment || !assignment.isActive) {
      return {
        ok: false,
        message: `You are not assigned as an Account Officer for this cooperative. Contact a super admin to be assigned.`,
      };
    }
    // Check if this admin already acted as Super Admin on this loan
    if (opts.actorId && (loan.finalApprovedById === opts.actorId || loan.superApproved2ById === opts.actorId)) {
      return {
        ok: false,
        message: `⛔ You have already acted on this loan in another role. The same person cannot fill multiple approval roles.`,
      };
    }

    const moved = await prisma.loan.updateMany({
      where: { id: loan.id, status: "guaranteed" },
      data: {
        status: "account_officer_approved",
        accountOfficerApprovedById: opts.actorId,
        accountOfficerApprovedAt: new Date(),
      },
    });
    if (moved.count === 0) {
      return { ok: false, message: `Loan *${shortId}* was just updated by another officer. Check *pending*.` };
    }
    // Audit log
    await audit({
      cooperativeId: opts.cooperativeId,
      actorPhone: (await prisma.member.findUnique({ where: { id: opts.actorId! } }))?.phone ?? opts.actorId!,
      actorId: opts.actorId!,
      actorRole: "account_officer",
      action: "loan.account_officer_approve",
      targetType: "loan",
      targetId: loan.id,
      detail: `Account Officer approved loan *${shortId}* for ${loan.member.name}`,
    });
    // Notify applicant
    await notifyLoanStatusChange(loan, "account_officer_approved");
    // Notify next required approver (admin)
    await notifyNextApprover(loan, "admin_approved");
    return {
      ok: true,
      message: `Loan *${shortId}* for ${loan.member.name} approved by Account Officer. Awaiting admin approval.`,
    };
  }

  // Stage 1: PENDING → cannot be approved yet
  if (loan.status === "pending") {
    return {
      ok: false,
      message: `Loan *${shortId}* is still pending. It needs ${requiredGuarantors(await getMemberRole(loan.memberId))} guarantor(s) to confirm first.`,
    };
  }

  // Rejected states - terminal
  const rejectedStates = ["rejected", "rejected_by_guarantor", "rejected_by_officer", "rejected_by_super_1", "rejected_by_super_2"];
  if (rejectedStates.includes(loan.status)) {
    return {
      ok: false,
      message: `Loan *${shortId}* was previously rejected. Please submit a new application.`,
    };
  }

  // Already in terminal approved/disbursed state
  if (["approved", "disbursed", "paid"].includes(loan.status)) {
    return {
      ok: false,
      message: `Loan *${shortId}* is already ${loan.status}.`,
    };
  }

  // Unknown state
  return {
    ok: false,
    message: `Loan *${shortId}* is in an unexpected state (${loan.status}). Contact support.`,
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

  // Regulatory compliance: reject if interest rate exceeds CBN guidance ceiling.
  if (loan.interestRate > MAX_ALLOWED_RATE) {
    return { ok: false, message: `Loan *${loan.id.slice(-6)}* has an interest rate of ${loan.interestRate}% which exceeds the regulatory maximum of ${MAX_ALLOWED_RATE}%. Contact your cooperative registrar.` };
  }

  const monthly = calculateMonthlyPayment(loan.amount, loan.tenureMonths);
  const total = totalRepayable(loan.amount, loan.tenureMonths);
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
    `Loan *${loan.id.slice(-6)}* fully approved for ${loan.member.name}: ${formatBalance(loan.amount)} @ ${loan.interestRate}% APR declining balance for ${loan.tenureMonths} months. Monthly: ${formatBalance(Math.round(monthly))}.`;

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

/** Sentinel thrown when the wallet balance changed mid-repayment (rolls back the transaction). */
class RepayBalanceChangedError extends Error {}

/**
 * Member repays their loan monthly installment. Debited from wallet.
 */
export async function repayLoan(phone: string, loanId?: string, cooperativeId?: string): Promise<{ ok: boolean; message: string }> {
  const member = cooperativeId
    ? await prisma.member.findUnique({
        where: { cooperativeId_phone: { cooperativeId, phone } },
        include: { wallet: true },
      })
    : await prisma.member.findFirst({
        where: { phone },
        include: { wallet: true },
      });
  if (!member || !member.wallet) {
    return { ok: false, message: "No wallet found. Join a cooperative first." };
  }

  const loan = loanId
    ? await prisma.loan.findFirst({ where: { id: loanId, memberId: member.id } })
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

  const walletId = member.wallet.id;

  // NOTE: Interest is declining balance (reducing balance) per CBN guidance.
  // P&L: the interest slice of this installment is cooperative income; fines too.
  const interestPortion = calculateInterestPortion(loan.balance, loan.tenureMonths);
  const principalPortion = Math.max(0, amount - interestPortion);

  // Atomic: debit the wallet and update the loan/repayment/fines inside ONE
  // transaction so a mid-way failure rolls everything back — money can never
  // leave the wallet without the matching loan/repayment record.
  try {
    await prisma.$transaction(async (tx) => {
      // Conditional debit — only succeeds if the balance still covers totalDue.
      const debited = await tx.wallet.updateMany({
        where: { id: walletId, balance: { gte: totalDue } },
        data: { balance: { decrement: totalDue } },
      });
      if (debited.count === 0) {
        throw new RepayBalanceChangedError();
      }
      await tx.loan.update({
        where: { id: loan.id },
        data: { balance: { decrement: principalPortion } },
      });
      await tx.loanRepayment.create({
        data: { loanId: loan.id, amount },
      });
      // Fines go to the cooperative pot as a confirmed contribution.
      if (fine > 0) {
        await tx.contribution.create({
          data: {
            memberId: member.id,
            cooperativeId: member.cooperativeId,
            type: "fine",
            amount: fine,
            status: "confirmed",
            reference: `FINE-${loan.id.slice(-6)}-${Date.now()}`,
            note: `Late fine on loan ${loan.id.slice(-6)}`,
          },
        });
      }
    });
  } catch (err) {
    if (err instanceof RepayBalanceChangedError) {
      return { ok: false, message: "Your wallet balance changed — please try again." };
    }
    throw err;
  }

  await recordLedger({
    cooperativeId: member.cooperativeId,
    type: "income",
    category: "interest",
    amount: interestPortion,
    note: `Installment interest on loan ${loan.id.slice(-6)}`,
    reference: loan.id,
    fundType: "operational",
  });
  // Principal repayment: credits the bank account (the loan principal is returned to the cooperative)
  if (principalPortion > 0) {
    await recordLedger({
      cooperativeId: member.cooperativeId,
      type: "income",
      category: "loan_repayment",
      amount: principalPortion,
      note: `Principal repayment on loan ${loan.id.slice(-6)}`,
      reference: loan.id,
      fundType: "member",
    });
  }
  if (fine > 0) {
    await recordLedger({
      cooperativeId: member.cooperativeId,
      type: "income",
      category: "fine",
      amount: fine,
      note: `Late fine on loan ${loan.id.slice(-6)}`,
      reference: loan.id,
      fundType: "operational",
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

/**
 * Notify the loan applicant about a status change.
 */
async function notifyLoanStatusChange(loan: { id: string; memberId: string; member: { name: string } }, newStatus: string): Promise<void> {
  const member = await prisma.member.findUnique({ where: { id: loan.memberId } });
  if (!member) return;

  const statusMessages: Record<string, string> = {
    "guaranteed": `Your loan *${loan.id.slice(-6)}* has been guaranteed by all required guarantors. It is now awaiting Account Officer review.`,
    "account_officer_approved": `Your loan *${loan.id.slice(-6)}* has been approved by the Account Officer. It is now awaiting admin approval.`,
    "admin_approved": `Your loan *${loan.id.slice(-6)}* has been approved by admin. It is now awaiting the first super admin's approval.`,
    "super_approved_1": `Your loan *${loan.id.slice(-6)}* has received the first super admin approval. It needs one more super admin to approve before disbursement.`,
    "approved": `Your loan *${loan.id.slice(-6)}* has been fully approved! Funds will be disbursed to your account shortly.`,
    "disbursed": `Your loan *${loan.id.slice(-6)}* has been disbursed. Check your bank account.`,
    "rejected_by_guarantor": `Your loan *${loan.id.slice(-6)}* was rejected by a guarantor.`,
    "rejected_by_officer": `Your loan *${loan.id.slice(-6)}* was rejected by the Account Officer.`,
    "rejected_by_super_1": `Your loan *${loan.id.slice(-6)}* was rejected by the first super admin.`,
    "rejected_by_super_2": `Your loan *${loan.id.slice(-6)}* was rejected by the second super admin.`,
    "rejected": `Your loan *${loan.id.slice(-6)}* was rejected.`,
  };

  const message = statusMessages[newStatus] || `Your loan *${loan.id.slice(-6)}* status changed to ${newStatus}.`;
  await sendText({ to: member.phone, text: message });
}

/**
 * Notify the next required approver that a loan is waiting for their action.
 */
async function notifyNextApprover(loan: { id: string; cooperativeId: string; member: { name: string } }, nextStage: string): Promise<void> {
  if (nextStage === "admin_approved") {
    // Find admins (not super admins) in this cooperative
    const admins = await prisma.member.findMany({
      where: {
        cooperativeId: loan.cooperativeId,
        role: "admin",
        status: "active",
      },
    });
    for (const admin of admins) {
      await sendText({
        to: admin.phone,
        text: `Loan *${loan.id.slice(-6)}* (${loan.member.name}) is awaiting your admin approval. Reply *approve ${loan.id.slice(-6)}* to proceed.`,
      });
    }
  } else if (nextStage === "super_approved_1") {
    // Find super admins in this cooperative
    const superAdmins = await prisma.member.findMany({
      where: {
        cooperativeId: loan.cooperativeId,
        role: "super_admin",
        status: "active",
      },
    });
    for (const sa of superAdmins) {
      await sendText({
        to: sa.phone,
        text: `Loan *${loan.id.slice(-6)}* (${loan.member.name}) is awaiting first super admin approval. Reply *approve ${loan.id.slice(-6)}* to proceed.`,
      });
    }
  }
}

/**
 * Reject a loan at any approval stage.
 * Rejection is terminal - loan cannot be revived, must reapply.
 */
export async function rejectLoan(
  loanId: string,
  opts: { actorId: string; cooperativeId: string; reason: string; stage: "guarantor" | "officer" | "super_1" | "super_2" },
): Promise<{ ok: boolean; message: string }> {
  const loan = await findLoan(loanId, opts.cooperativeId);
  if (!loan) return { ok: false, message: "Loan not found. Check the id and try again." };
  const shortId = loan.id.slice(-6);

  // Applicant cannot reject their own loan
  if (opts.actorId && loan.memberId === opts.actorId) {
    return { ok: false, message: "You cannot reject your own loan application." };
  }

  // Determine rejection status based on current stage
  const rejectionStatusMap: Record<string, string> = {
    guarantor: "rejected_by_guarantor",
    officer: "rejected_by_officer",
    super_1: "rejected_by_super_1",
    super_2: "rejected_by_super_2",
  };

  const rejectionStatus = rejectionStatusMap[opts.stage];
  if (!rejectionStatus) {
    return { ok: false, message: "Invalid rejection stage." };
  }

  // Only allow rejection at appropriate stages
  const validStagesForRejection: Record<string, string[]> = {
    guarantor: ["pending", "guaranteed"],
    officer: ["guaranteed", "account_officer_approved"],
    super_1: ["admin_approved", "super_approved_1"],
    super_2: ["super_approved_1"],
  };

  const validStages = validStagesForRejection[opts.stage];
  if (!validStages.includes(loan.status)) {
    return { ok: false, message: `Cannot reject at this stage (${loan.status}). Loan must be at a stage where ${opts.stage} can act.` };
  }

  // Verify actor has permission for this stage
  if (opts.stage === "officer") {
    const assignment = await prisma.accountOfficerAssignment.findUnique({
      where: {
        accountOfficerId_cooperativeId: {
          accountOfficerId: opts.actorId,
          cooperativeId: opts.cooperativeId,
        },
      },
    });
    if (!assignment || !assignment.isActive) {
      return { ok: false, message: "You are not an active Account Officer for this cooperative." };
    }
  } else if (opts.stage === "super_1" || opts.stage === "super_2") {
    const actor = await prisma.member.findUnique({ where: { id: opts.actorId } });
    if (!actor || actor.role !== "super_admin") {
      return { ok: false, message: "Only super admins can reject at this stage." };
    }
  }

  // Atomic update to rejected status
  const updated = await prisma.loan.updateMany({
    where: { id: loan.id, status: { in: validStages } },
    data: { status: rejectionStatus },
  });

  if (updated.count === 0) {
    return { ok: false, message: `Loan *${shortId}* was just updated by another action. Check *pending*.` };
  }

  // Audit log
  await audit({
    cooperativeId: opts.cooperativeId,
    actorPhone: (await prisma.member.findUnique({ where: { id: opts.actorId } }))?.phone ?? opts.actorId,
    actorId: opts.actorId,
    actorRole: opts.stage === "guarantor" ? "guarantor" : opts.stage === "officer" ? "account_officer" : "super_admin",
    action: `loan.reject_by_${opts.stage}`,
    targetType: "loan",
    targetId: loan.id,
    detail: `Rejected loan *${shortId}* for ${loan.member.name} at ${opts.stage} stage. Reason: ${opts.reason}`,
  });

  // Notify applicant
  await notifyLoanStatusChange(loan, rejectionStatus);

  // Clear queue position
  await prisma.loan.update({
    where: { id: loan.id },
    data: { queuePosition: null, queueJoinedAt: null },
  });
  await renumberQueue(loan.cooperativeId);

  return {
    ok: true,
    message: `Loan *${shortId}* for ${loan.member.name} has been rejected (${rejectionStatus}). Reason: ${opts.reason}. The applicant must submit a new application.`,
  };
}