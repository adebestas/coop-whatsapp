import { prisma } from "../lib/prisma.js";
import { formatBalance } from "./cooperative.js";

export interface ApplyLoanResult {
  ok: boolean;
  message: string;
  loanId?: string;
}

/** Apply for a loan. Amount + tenure months come from the chat. */
export async function applyForLoan(
  phone: string,
  amount: number,
  tenureMonths: number,
  interestRate = 2,
): Promise<ApplyLoanResult> {
  const member = await prisma.member.findFirst({ where: { phone } });
  if (!member) {
    return { ok: false, message: "You need to join a cooperative first. Reply *join <code>*." };
  }
  if (!Number.isFinite(amount) || amount <= 0 || tenureMonths < 1 || tenureMonths > 12) {
    return { ok: false, message: "Use the format *loan <amount> <months>*, e.g. *loan 50000 3* (up to 12 months)." };
  }

  const loan = await prisma.loan.create({
    data: {
      amount,
      interestRate,
      tenureMonths,
      status: "pending",
      balance: amount,
      memberId: member.id,
      cooperativeId: member.cooperativeId,
    },
  });

  const total = amount * (1 + (interestRate / 100) * tenureMonths);
  const monthly = total / tenureMonths;

  return {
    ok: true,
    loanId: loan.id,
    message:
      `Loan application received ✅\n\n` +
      `Amount: *${formatBalance(amount)}*\n` +
      `Tenure: *${tenureMonths} months*\n` +
      `Interest: *${interestRate}%/month*\n` +
      `Estimated total: *${formatBalance(Math.round(total))}*\n` +
      `Estimated monthly: *${formatBalance(Math.round(monthly))}*\n\n` +
      `You still need to add *2 guarantors* before the loan can be approved.`,
  };
}

export async function listPendingLoans(cooperativeId: string, limit = 20) {
  return prisma.loan.findMany({
    where: { cooperativeId, status: { in: ["pending", "guaranteed"] } },
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

export async function approveLoan(loanId: string, interestRate?: number): Promise<{ ok: boolean; message: string }> {
  const loan = await findLoan(loanId);
  if (!loan) return { ok: false, message: "Loan not found. Check the id and try again." };
  if (loan.status !== "guaranteed") {
    return {
      ok: false,
      message: `Loan *${loan.id.slice(-6)}* can't be approved yet. It must have 2 confirmed guarantors (current status: ${loan.status}).`,
    };
  }

  const rate = interestRate ?? loan.interestRate;
  const total = loan.amount * (1 + (rate / 100) * loan.tenureMonths);
  const monthly = total / loan.tenureMonths;
  const due = new Date();
  due.setMonth(due.getMonth() + 1);

  await prisma.loan.update({
    where: { id: loan.id },
    data: {
      status: "approved",
      interestRate: rate,
      monthlyPayment: Math.round(monthly * 100) / 100,
      balance: Math.round(total * 100) / 100,
      approvedAt: new Date(),
      dueDate: due,
    },
  });

  return {
    ok: true,
    message: `Loan *${loan.id.slice(-6)}* approved for ${loan.member.name}. ${formatBalance(loan.amount)} @ ${rate}%/mo for ${loan.tenureMonths} months. Monthly: ${formatBalance(Math.round(monthly))}.`,
  };
}

export async function rejectLoan(loanId: string): Promise<{ ok: boolean; message: string }> {
  const loan = await findLoan(loanId);
  if (!loan) return { ok: false, message: "Loan not found. Check the id and try again." };
  if (loan.status !== "pending") return { ok: false, message: `Loan is already ${loan.status}.` };

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
  if (member.wallet.balance < amount) {
    return {
      ok: false,
      message: `Your wallet balance (${formatBalance(member.wallet.balance)}) is less than the installment (${formatBalance(amount)}). Reply *fund* to top up first.`,
    };
  }

  await prisma.$transaction([
    prisma.wallet.update({
      where: { id: member.wallet.id },
      data: { balance: { decrement: amount } },
    }),
    prisma.loan.update({
      where: { id: loan.id },
      data: { balance: { decrement: amount } },
    }),
    prisma.loanRepayment.create({
      data: { loanId: loan.id, amount },
    }),
  ]);

  const updated = await prisma.loan.findUnique({ where: { id: loan.id } });
  const isPaid = (updated?.balance ?? 0) <= 0;
  if (isPaid) {
    await prisma.loan.update({ where: { id: loan.id }, data: { status: "paid" } });
  } else if (updated?.dueDate) {
    const next = new Date(updated.dueDate);
    next.setMonth(next.getMonth() + 1);
    await prisma.loan.update({ where: { id: loan.id }, data: { dueDate: next } });
  }

  return {
    ok: true,
    message: `✅ Repaid ${formatBalance(amount)} on loan *${loan.id.slice(-6)}*.${isPaid ? " This loan is now fully paid 🎉" : ` Remaining balance: ${formatBalance(updated?.balance ?? 0)}.`}`,
  };
}