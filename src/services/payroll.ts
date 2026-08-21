import { prisma } from "../lib/prisma.js";
import { sendText } from "../lib/messaging.js";
import { formatBalance } from "./cooperative.js";
import { audit } from "./audit.js";
import { recordLedger } from "./ledger.js";
import { sendToBank } from "./disbursements.js";
import { checkDailyPayoutLimit } from "./fraud.js";

export interface PayrollResult {
  ok: boolean;
  message: string;
  paid?: number;
  total?: number;
}

/**
 * Super admin sets a monthly salary/stipend amount for a super admin.
 * Nothing is paid automatically — a super admin triggers payroll manually
 * with `runpayroll <narration>`, and money goes to BANK ACCOUNTS (never
 * wallets).
 */
export async function setSalary(
  actor: { id: string; phone: string; role: string; cooperativeId: string },
  targetPhone: string,
  amountOrOff: number | "off",
): Promise<{ ok: boolean; message: string }> {
  if (actor.role !== "superadmin") {
    return { ok: false, message: "Only *super admins* manage salaries." };
  }

  const target = await prisma.member.findFirst({
    where: { cooperativeId: actor.cooperativeId, OR: [{ contactPhone: targetPhone }, { phone: targetPhone }] },
  });
  if (!target) return { ok: false, message: "Member not found." };

  if (target.role !== "superadmin") {
    return { ok: false, message: `${target.name} is not a super admin — salaries are for super admins.` };
  }

  // Dual-control: nobody sets their OWN pay.
  if (actor.id === target.id) {
    return {
      ok: false,
      message: "⛔ You can't set your own salary. Another super admin must do that.",
    };
  }

  const off = amountOrOff === "off";
  await prisma.member.update({
    where: { id: target.id },
    data: off
      ? { salaryAmount: null, salaryKind: null }
      : { salaryAmount: amountOrOff, salaryKind: "stipend" },
  });

  await audit({
    cooperativeId: actor.cooperativeId,
    actorPhone: actor.phone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "payroll.set",
    targetType: "member",
    targetId: target.id,
    detail: off ? "salary removed" : `${formatBalance(amountOrOff)}/month`,
  });

  return {
    ok: true,
    message: off
      ? `Salary stopped for ${target.name}.`
      : `✅ ${target.name} is set to receive *${formatBalance(amountOrOff)}* per run — paid to their bank account when a super admin runs *runpayroll <narration>*.`,
  };
}

/** List super admins with their configured pay and bank-on-file readiness. */
export async function payrollOverview(cooperativeId: string) {
  return prisma.member.findMany({
    where: { cooperativeId, role: "superadmin" },
    select: {
      name: true,
      phone: true,
      salaryAmount: true,
      salaryKind: true,
      bankAccountNumber: true,
      bankName: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Manual payroll run — pays every configured super admin straight to their
 * bank account on file (name-verified), NEVER to wallets. Requires a
 * narration for the records.
 */
export async function runPayroll(
  cooperativeId: string,
  triggeredBy: { id: string; phone: string; role: string },
  narration: string,
): Promise<PayrollResult> {
  if (!narration || narration.trim().length < 3) {
    return { ok: false, message: "Every payment needs a *narration*: *runpayroll <narration>* — e.g. *runpayroll October stipends*." };
  }

  const recipients = await prisma.member.findMany({
    where: { cooperativeId, role: "superadmin", salaryAmount: { gt: 0 } },
    include: { wallet: true },
  });

  if (recipients.length === 0) {
    return {
      ok: true,
      message: "No salaries configured yet. Set them with *setsalary <phone> <amount>*, then run payroll.",
      paid: 0,
      total: 0,
    };
  }

  let paid = 0;
  let total = 0;
  const failures: string[] = [];
  // One stipend per member per calendar month — a re-run can never double-pay.
  const period = new Date().toISOString().slice(0, 7);

  for (const r of recipients) {
    const amount = r.salaryAmount!;

    // Dual-control on execution: the runner never pays themselves.
    if (r.id === triggeredBy.id) {
      failures.push(`${r.name} — skipped: you can't run payroll that pays yourself; another super must run it`);
      continue;
    }

    // Salaries go to the member's registered bank account, not the wallet.
    if (!r.bankAccountNumber || !r.bankCode) {
      failures.push(`${r.name} — no bank account on file`);
      continue;
    }

    const limit = await checkDailyPayoutLimit(cooperativeId, amount);
    if (!limit.ok) {
      failures.push(limit.message!);
      break;
    }

    const result = await sendToBank({
      memberId: r.id,
      amount,
      bankAccountNumber: r.bankAccountNumber,
      bankCode: r.bankCode,
      bankName: r.bankName ?? undefined,
      note: `${r.salaryKind ?? "stipend"} — ${narration.trim()}`,
      successMessage: `💰 ${r.salaryKind === "salary" ? "Salary" : "Stipend"} paid: *${formatBalance(amount)}* to your bank account. Narration: "${narration.trim()}".`,
      idempotencyKey: `TFR-PAYROLL-${r.id}-${period}`,
      onFailure: async () => {},
    });

    if (!result.ok) {
      failures.push(`${r.name} — ${result.message}`);
      continue;
    }

    await recordLedger({
      cooperativeId,
      type: "expense",
      category: r.salaryKind === "salary" ? "salary" : "stipend",
      amount,
      note: `${r.salaryKind ?? "stipend"} to ${r.name} — ${narration.trim()}`,
      reference: r.id,
    });
    paid += 1;
    total += amount;

    if (limit.warning) await sendText({ to: triggeredBy.phone, text: limit.warning }).catch(() => {});
  }

  await audit({
    cooperativeId,
    actorPhone: triggeredBy.phone,
    actorId: triggeredBy.id,
    actorRole: triggeredBy.role,
    action: "payroll.run",
    detail: `"${narration.trim()}" — ${paid} paid (${formatBalance(total)}), ${failures.length} failed`,
  });

  const lines = [
    `💼 Payroll ("${narration.trim()}"): *${paid}* paid, *${formatBalance(total)}* total to bank accounts.`,
  ];
  if (failures.length > 0) lines.push(`⚠️ Not paid:\n• ${failures.join("\n• ")}`);

  return { ok: true, message: lines.join("\n\n"), paid, total };
}
