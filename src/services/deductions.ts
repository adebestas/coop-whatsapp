import { prisma } from "../lib/prisma.js";
import { notifyMember, sendText } from "../lib/messaging.js";
import { formatBalance, getMemberByPhone } from "./cooperative.js";
import { audit } from "./audit.js";
import { notifySuperAdmins } from "./withdrawals.js";

/** "YYYY-MM" for a date, in UTC. */
export function periodOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isSuperPhone(phone: string, cooperativeId: string): Promise<boolean> {
  return prisma.member
    .findFirst({
      where: { phone, cooperativeId },
      include: { cooperative: true },
    })
    .then(
      (m) =>
        !!m && (m.role === "superadmin" || m.cooperative.adminPhone === m.phone),
    );
}

/**
 * Build a draft remittance batch from every member's agreed monthly
 * deduction. Members waived for the current period are skipped entirely.
 * A member with an active (disbursed) loan gets a second item so their
 * installment is repaid out of the same employer remittance — savings are
 * still credited alongside it.
 */
export async function buildBatch(
  adminPhone: string,
  note?: string,
): Promise<{ ok: boolean; message: string }> {
  const admin = await prisma.member.findFirst({
    where: { phone: adminPhone, role: { in: ["admin", "superadmin"] } },
    include: { cooperative: true },
  });
  if (!admin) return { ok: false, message: "Admin account not found." };
  const coopId = admin.cooperativeId;

  const period = periodOf(new Date());
  const waived = await prisma.deductionWaiver.findMany({
    where: { member: { cooperativeId: coopId }, period },
  });
  const waivedIds = new Set(waived.map((w) => w.memberId));

  const members = await prisma.member.findMany({
    where: { cooperativeId: coopId, status: "active" },
    include: {
      loans: { where: { status: "disbursed" }, orderBy: { createdAt: "asc" } },
    },
  });

  type DraftItem = { memberId: string; kind: "savings" | "loan"; loanId?: string; amount: number };
  const items: DraftItem[] = [];
  for (const m of members) {
    if (waivedIds.has(m.id)) continue;
    if (m.monthlyDeduction && m.monthlyDeduction > 0) {
      items.push({ memberId: m.id, kind: "savings", amount: m.monthlyDeduction });
    }
    const loan = m.loans.find((l) => l.balance > 0);
    if (loan) {
      const installment =
        loan.monthlyPayment && loan.monthlyPayment > 0
          ? Math.min(loan.monthlyPayment, loan.balance)
          : loan.balance;
      items.push({ memberId: m.id, kind: "loan", loanId: loan.id, amount: Math.round(installment * 100) / 100 });
    }
  }
  if (items.length === 0) {
    return { ok: false, message: `Nothing to collect for ${period} — no member has a monthly deduction set (use *setcommit <code> <amount>*), and nobody is repaying a loan.` };
  }

  const total = items.reduce((s, i) => s + i.amount, 0);
  const ref = `DED-${period}-${Date.now().toString(36).toUpperCase()}`;
  await prisma.deductionBatch.create({
    data: {
      ref,
      cooperativeId: coopId,
      createdById: admin.id,
      note,
      totalAmount: total,
      items: { create: items.map((i) => ({ memberId: i.memberId, kind: i.kind, loanId: i.loanId ?? null, amount: i.amount })) },
    },
  });

  const savers = new Set(items.filter((i) => i.kind === "savings").map((i) => i.memberId)).size;
  const payers = new Set(items.filter((i) => i.kind === "loan").map((i) => i.memberId)).size;
  return {
    ok: true,
    message:
      `📋 Batch *${ref}* built (${period}).\n` +
      `• Savings: ${savers} member(s)\n` +
      `• Loan repayments: ${payers}\n` +
      `• Total expected: *${formatBalance(total)}*\n` +
      `Review it, then send *submitbatch ${ref}* when the employer cheque is logged.`,
  };
}

export async function submitBatch(
  adminPhone: string,
  rawRef: string,
): Promise<{ ok: boolean; message: string }> {
  const ref = rawRef.trim().toUpperCase();
  const batch = await prisma.deductionBatch.findUnique({
    where: { ref },
    include: { createdBy: true },
  });
  if (!batch || batch.createdBy.phone !== adminPhone) {
    return { ok: false, message: "Batch not found." };
  }
  if (batch.status !== "draft") {
    return { ok: false, message: `Batch ${ref} is already ${batch.status}.` };
  }
  await prisma.deductionBatch.update({ where: { id: batch.id }, data: { status: "submitted" } });
  await notifySuperAdmins(
    batch.cooperativeId,
    `📥 Deduction batch *${ref}* submitted by ${batch.createdBy.name} — expected *${formatBalance(batch.totalAmount)}*.\nConfirm the employer payment cleared, then approve with *approvebatch ${ref}*.`,
  );
  return { ok: true, message: `✅ Batch ${ref} submitted. Waiting for super-admin approval.` };
}

/**
 * Super admin confirms the employer money landed: every savings item is
 * credited to the member's wallet and every loan item pays down the
 * member's active loan. Each affected member is notified on their own
 * platform.
 */
export async function approveBatch(
  superPhone: string,
  rawRef: string,
): Promise<{ ok: boolean; message: string }> {
  const ref = rawRef.trim().toUpperCase();
  const batch = await prisma.deductionBatch.findUnique({
    where: { ref },
    include: { items: { include: { member: { include: { wallet: true } } } } },
  });
  if (!batch) return { ok: false, message: "Batch not found." };
  if (!(await isSuperPhone(superPhone, batch.cooperativeId))) {
    return { ok: false, message: "Only the *super admin* can approve deduction batches." };
  }
  if (batch.status !== "submitted") {
    return { ok: false, message: `Batch ${ref} is ${batch.status}, not submitted.` };
  }

  let savedCount = 0;
  let repaidCount = 0;
  let totalSaved = 0;
  let totalRepaid = 0;

  for (const item of batch.items) {
    if (item.status !== "pending") continue;
    const member = item.member;

    if (item.kind === "savings") {
      await prisma.contribution.create({
        data: {
          amount: item.amount,
          reference: `${item.batchId}-${item.id}`.slice(0, 60),
          status: "confirmed",
          paidAt: new Date(),
          memberId: member.id,
          cooperativeId: member.cooperativeId,
        },
      });
      if (member.wallet) {
        await prisma.wallet.update({
          where: { id: member.wallet.id },
          data: { balance: { increment: item.amount }, totalSaved: { increment: item.amount } },
        });
      }
      await notifyMember(
        member,
        `💰 ${formatBalance(item.amount)} salary deduction received and credited to your savings.`,
      ).catch(() => {});
      savedCount += 1;
      totalSaved += item.amount;
    } else if (item.loanId) {
      const loan = await prisma.loan.findUnique({ where: { id: item.loanId } });
      if (loan && loan.status === "disbursed" && loan.balance > 0) {
        const applied = Math.min(item.amount, loan.balance);
        const newBalance = Math.max(0, Math.round((loan.balance - applied) * 100) / 100);
        await prisma.loan.update({
          where: { id: loan.id },
          data: {
            balance: newBalance,
            ...(newBalance === 0 ? { status: "paid" } : {}),
          },
        });
        await prisma.loanRepayment.create({ data: { amount: applied, loanId: loan.id } });
        await notifyMember(
          member,
          newBalance === 0
            ? `🎉 Loan repayment of ${formatBalance(applied)} received — your loan is now *fully repaid*.`
            : `📄 Loan repayment of ${formatBalance(applied)} received. Remaining balance: ${formatBalance(newBalance)}.`,
        ).catch(() => {});
        repaidCount += 1;
        totalRepaid += applied;
      }
    }
    await prisma.deductionItem.update({
      where: { id: item.id },
      data: { status: "credited", creditedAt: new Date() },
    });
  }

  await prisma.deductionBatch.update({
    where: { id: batch.id },
    data: { status: "approved", approvedAt: new Date(), approvedById: (await prisma.member.findFirst({ where: { phone: superPhone, cooperativeId: batch.cooperativeId } }))?.id ?? null },
  });
  await audit({
    cooperativeId: batch.cooperativeId,
    actorPhone: superPhone,
    actorRole: "superadmin",
    action: "deduction.batch.approve",
    targetType: "deductionBatch",
    detail: `${ref}: saved ${formatBalance(totalSaved)} (${savedCount}), repaid ${formatBalance(totalRepaid)} (${repaidCount})`,
  });

  return {
    ok: true,
    message:
      `✅ Batch *${ref}* approved.\n` +
      `• Credited ${formatBalance(totalSaved)} to ${savedCount} member(s)\n` +
      `• Applied ${formatBalance(totalRepaid)} to ${repaidCount} loan(s)\n` +
      `Everyone has been notified on their preferred platform.`,
  };
}

export async function rejectBatch(
  superPhone: string,
  rawRef: string,
  reason?: string,
): Promise<{ ok: boolean; message: string }> {
  const ref = rawRef.trim().toUpperCase();
  const batch = await prisma.deductionBatch.findUnique({ where: { ref }, include: { createdBy: true } });
  if (!batch) return { ok: false, message: "Batch not found." };
  if (!(await isSuperPhone(superPhone, batch.cooperativeId))) {
    return { ok: false, message: "Only the *super admin* can reject deduction batches." };
  }
  if (batch.status !== "submitted") {
    return { ok: false, message: `Batch ${ref} is ${batch.status}, not submitted.` };
  }
  await prisma.deductionBatch.update({
    where: { id: batch.id },
    data: { status: "rejected", approvedAt: new Date(), note: reason ?? batch.note },
  });
  await sendText({
    to: batch.createdBy.phone,
    text: `❌ Batch *${ref}* was rejected${reason ? `: ${reason}` : "."}`,
  });
  await audit({
    cooperativeId: batch.cooperativeId,
    actorPhone: superPhone,
    actorRole: "superadmin",
    action: "deduction.batch.reject",
    targetType: "deductionBatch",
    detail: `${ref}${reason ? `: ${reason}` : ""}`,
  });
  return { ok: true, message: `Batch ${ref} rejected.` };
}

/** Admin sets/changes a member's agreed monthly salary deduction. */
export async function setCommitment(
  adminPhone: string,
  code: string,
  amount: number,
): Promise<{ ok: boolean; message: string }> {
  const admin = await prisma.member.findFirst({
    where: { phone: adminPhone, role: { in: ["admin", "superadmin"] } },
    include: { cooperative: true },
  });
  if (!admin) return { ok: false, message: "Admin account not found." };
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, message: "Usage: *setcommit <member code> <amount>* (0 stops the deduction)." };
  }
  const target = await prisma.member.findFirst({
    where: { code: code.toUpperCase(), cooperativeId: admin.cooperativeId },
    include: { wallet: true },
  });
  if (!target) return { ok: false, message: `No member found with code ${code}.` };

  await prisma.member.update({ where: { id: target.id }, data: { monthlyDeduction: amount } });
  await audit({
    cooperativeId: admin.cooperativeId,
    actorPhone: adminPhone,
    actorRole: admin.role,
    action: "deduction.commit.set",
    targetType: "member",
    targetId: target.id,
    detail: `${target.name}: ${formatBalance(amount)}/month`,
  });
  await notifyMember(
    target,
    amount > 0
      ? `📌 Your monthly cooperative deduction is now *${formatBalance(amount)}*, set by your co-op admin.`
      : `📌 Your monthly cooperative deduction has been *stopped* by your co-op admin.`,
  ).catch(() => {});
  return {
    ok: true,
    message: `✅ ${target.name}'s monthly deduction set to ${amount > 0 ? formatBalance(amount) : "stopped"}. They have been notified.`,
  };
}

/** Admin waives a member's deductions for one month. */
export async function waiveMonth(
  adminPhone: string,
  code: string,
  periodArg?: string,
): Promise<{ ok: boolean; message: string }> {
  const admin = await prisma.member.findFirst({
    where: { phone: adminPhone, role: { in: ["admin", "superadmin"] } },
    include: { cooperative: true },
  });
  if (!admin) return { ok: false, message: "Admin account not found." };
  const target = await prisma.member.findFirst({
    where: { code: code.toUpperCase(), cooperativeId: admin.cooperativeId },
  });
  if (!target) return { ok: false, message: `No member found with code ${code}.` };
  const period = periodArg?.trim() || periodOf(new Date());
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return { ok: false, message: "Use period format YYYY-MM, e.g. *waive A1B2C3 2026-09*." };
  }
  await prisma.deductionWaiver.upsert({
    where: { memberId_period: { memberId: target.id, period } },
    create: { memberId: target.id, period, grantedById: admin.id },
    update: { grantedById: admin.id },
  });
  await audit({
    cooperativeId: admin.cooperativeId,
    actorPhone: adminPhone,
    actorRole: admin.role,
    action: "deduction.waive",
    targetType: "member",
    targetId: target.id,
    detail: `${target.name} waived for ${period}`,
  });
  await notifyMember(
    target,
    `🤝 Your co-op admin has waived your deduction for ${period}. You will not be deducted this month.`,
  ).catch(() => {});
  return { ok: true, message: `✅ ${target.name} is waived for ${period}. They have been notified.` };
}

/** Member view of their own deduction commitment. */
export async function myDeduction(phone: string): Promise<{ ok: boolean; message: string }> {
  const member = await getMemberByPhone(phone);
  if (!member) return { ok: false, message: "You need to join a cooperative first. Reply *join <code>* to get started." };

  const fresh = await prisma.member.findUnique({
    where: { id: member.id },
    include: { loans: { where: { status: "disbursed" } }, deductionWaivers: true },
  });
  const lines: string[] = ["📌 *Your monthly deduction*", ""];
  lines.push(`• Savings commitment: ${fresh?.monthlyDeduction ? formatBalance(fresh.monthlyDeduction) : "_not set_"}`);
  const loan = fresh?.loans.find((l) => l.balance > 0);
  if (loan) {
    const next = loan.monthlyPayment && loan.monthlyPayment > 0
      ? Math.min(loan.monthlyPayment, loan.balance)
      : loan.balance;
    lines.push(`• Loan repayment: ${formatBalance(next)}/month (${formatBalance(loan.balance)} left)`);
  }
  const period = periodOf(new Date());
  if (fresh?.deductionWaivers.some((w) => w.period === period)) {
    lines.push(`• Waived for ${period} 🎉`);
  }
  return { ok: true, message: lines.join("\n") };
}

/** Member asks to skip this month — pings admins to confirm. */
export async function requestMonthWaiver(phone: string): Promise<{ ok: boolean; message: string }> {
  const member = await getMemberByPhone(phone);
  if (!member) return { ok: false, message: "You need to join a cooperative first. Reply *join <code>* to get started." };
  const already = await prisma.deductionWaiver.findFirst({
    where: { memberId: member.id, period: periodOf(new Date()) },
  });
  if (already) {
    return { ok: true, message: `You are already waived for ${already.period} ✅.` };
  }
  await notifySuperAdmins(
    member.cooperativeId,
    `🙏 ${member.name} (${member.code}) is requesting a waiver of this month's deduction (${periodOf(new Date())}). Approve with *waive ${member.code}*.`,
  );
  return {
    ok: true,
    message: `🙏 Request sent to your co-op admins. If they approve, you will be notified and nothing will be deducted for ${periodOf(new Date())}.`,
  };
}
