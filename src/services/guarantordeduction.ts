import { prisma } from "../lib/prisma.js";
import { notifyMember } from "../lib/messaging.js";
import { formatBalance } from "./cooperative.js";
import { audit } from "./audit.js";
import { recordLedger } from "./ledger.js";

/** How many months of default trigger guarantor liability. */
export const DEFAULT_GRACE_MONTHS = 2;
/** Share of the loan's flat interest each guarantor absorbs. */
export const GUARANTOR_INTEREST_SHARE = 0.5;
/** Days between the warning notice and the actual deduction. */
export const DEDUCTION_NOTICE_DAYS = 10;

/**
 * Daily scan: find loans whose due date is 2+ months past (still owing) and
 * notify each guarantor that 50% of the loan's flat interest will be deducted
 * from their savings in 10 days. Idempotent — one notice per loan+guarantor.
 */
export async function scanGuarantorDefaults(): Promise<number> {
  const twoMonthsAgo = new Date();
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - DEFAULT_GRACE_MONTHS);

  const defaulted = await prisma.loan.findMany({
    where: {
      status: "disbursed",
      balance: { gt: 0 },
      dueDate: { lt: twoMonthsAgo },
    },
    include: {
      member: { select: { name: true, phone: true } },
      guarantors: { where: { status: "confirmed" }, include: { member: true } },
    },
  });

  let notices = 0;
  for (const loan of defaulted) {
    const flatInterest = Math.round(loan.amount * ((loan.interestRate ?? 0) / 100) * 100) / 100;
    const share = Math.round(flatInterest * GUARANTOR_INTEREST_SHARE * 100) / 100;
    if (share <= 0) continue;

    for (const g of loan.guarantors) {
      const existing = await prisma.guarantorDeduction.findUnique({
        where: { loanId_guarantorId: { loanId: loan.id, guarantorId: g.memberId } },
      });
      if (existing && existing.status !== "cancelled") continue;

      const deductAt = new Date();
      deductAt.setDate(deductAt.getDate() + DEDUCTION_NOTICE_DAYS);

      await prisma.guarantorDeduction.upsert({
        where: { loanId_guarantorId: { loanId: loan.id, guarantorId: g.memberId } },
        create: {
          cooperativeId: loan.cooperativeId,
          loanId: loan.id,
          guarantorId: g.memberId,
          amount: share,
          noticeSentAt: new Date(),
          deductAt,
        },
        update: { status: "notified", deductAt },
      });

      await notifyMember(
        g.member,
        `⚠️ *10-day deduction notice*\n\n` +
          `${loan.member.name} has defaulted on loan *${loan.id.slice(-6)}* for ${DEFAULT_GRACE_MONTHS}+ months.\n` +
          `As guarantor, *${formatBalance(share)}* (50% of the loan's interest) will be deducted from your savings on ` +
          `*${deductAt.toISOString().slice(0, 10)}*.\n\n` +
          `If the borrower clears the arrears before then, the deduction is cancelled.`,
      ).catch(() => {});
      notices += 1;
    }
  }

  return notices;
}

/**
 * Daily execution: deduct from savings where the notice period has passed AND
 * the loan is still in default. Loans brought current get their notices
 * cancelled automatically.
 */
export async function executeDueDeductions(): Promise<{ deducted: number; cancelled: number }> {
  const now = new Date();

  // 1. Cancel notices for loans that are no longer in default.
  const pendingNotices = await prisma.guarantorDeduction.findMany({
    where: { status: "notified" },
  });
  let cancelled = 0;
  for (const n of pendingNotices) {
    const stillDefaulted = await prisma.loan.findFirst({
      where: { id: n.loanId, status: "disbursed", balance: { gt: 0 }, dueDate: { lt: now } },
    });
    if (!stillDefaulted) {
      await prisma.guarantorDeduction.update({
        where: { id: n.id },
        data: { status: "cancelled", note: "loan brought current before deduction" },
      });
      cancelled += 1;
    }
  }

  // 2. Execute deductions that are due.
  const due = await prisma.guarantorDeduction.findMany({
    where: { status: "notified", deductAt: { lte: now } },
    include: { guarantor: { include: { wallet: true } } },
  });

  let deducted = 0;
  for (const d of due) {
    const wallet = d.guarantor.wallet;
    if (!wallet || wallet.balance < d.amount) {
      // Not enough savings — retry tomorrow.
      continue;
    }

    // Atomic debit from the guarantor's savings.
    const debited = await prisma.wallet.updateMany({
      where: { id: wallet.id, balance: { gte: d.amount } },
      data: { balance: { decrement: d.amount }, totalSaved: { decrement: d.amount } },
    });
    if (debited.count === 0) continue;

    await prisma.guarantorDeduction.update({
      where: { id: d.id },
      data: { status: "deducted", deductedAt: new Date(), note: "auto-deducted after notice period" },
    });

    await recordLedger({
      cooperativeId: d.cooperativeId,
      type: "income",
      category: "guarantee_recovery",
      amount: d.amount,
      note: `Guarantor recovery on loan ${d.loanId.slice(-6)} (${d.guarantor.name})`,
      reference: d.id,
    });
    await audit({
      cooperativeId: d.cooperativeId,
      actorPhone: "system",
      actorId: null,
      actorRole: "system",
      action: "guarantor.deduct",
      targetType: "guarantor_deduction",
      targetId: d.id,
      detail: `${formatBalance(d.amount)} from ${d.guarantor.name} for loan ${d.loanId.slice(-6)}`,
    });

    await notifyMember(
      d.guarantor,
      `⚠️ As notified 10 days ago, *${formatBalance(d.amount)}* was deducted from your savings — your borrower on loan *${d.loanId.slice(-6)}* is still in default.`,
    ).catch(() => {});
    deducted += 1;
  }

  return { deducted, cancelled };
}
