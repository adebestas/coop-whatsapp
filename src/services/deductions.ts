import { prisma, withTx } from "../lib/prisma.js";
import { notifyMember, sendText } from "../lib/messaging.js";
import { formatBalance, getMemberByPhone } from "./cooperative.js";
import { audit } from "./audit.js";
import { qualifyReferral } from "./referrals.js";
import { notifySuperAdmins } from "./withdrawals.js";

type DraftItem = {
  memberId: string;
  kind: "savings" | "loan" | "commodity";
  loanId?: string;
  amount: number;
};

/**
 * Commodity loans still being repaid, as payroll items. A loan already queued in
 * an open batch is skipped so the same installment is never collected twice.
 */
async function commodityDraftItems(coopId: string): Promise<DraftItem[]> {
  const queued = await prisma.deductionItem.findMany({
    where: {
      kind: "commodity",
      status: "pending",
      batch: {
        cooperativeId: coopId,
        status: { in: ["draft", "submitted", "reconciled", "partially_approved"] },
      },
    },
    select: { loanId: true },
  });
  const queuedLoanIds = new Set(queued.map((i) => i.loanId));
  const loans = await prisma.loan.findMany({
    where: { cooperativeId: coopId, kind: "commodity", status: "disbursed", balance: { gt: 0 } },
    orderBy: { createdAt: "asc" },
  });
  return loans
    .filter((loan) => !queuedLoanIds.has(loan.id))
    .map((loan) => {
      const installment =
        loan.monthlyPayment && loan.monthlyPayment > 0
          ? Math.min(loan.monthlyPayment, loan.balance)
          : loan.balance;
      return {
        memberId: loan.memberId,
        kind: "commodity" as const,
        loanId: loan.id,
        amount: Math.round(installment * 100) / 100,
      };
    });
}

/** "YYYY-MM" for a date, in UTC. */
export function periodOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isSuperPhone(phone: string, cooperativeId: string): Promise<boolean> {
  return prisma.member
    .findFirst({
      where: { phone, cooperativeId, role: "superadmin" },
    })
    .then((m) => !!m);
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
      loans: { where: { status: "disbursed", kind: "cash" }, orderBy: { createdAt: "asc" } },
    },
  });

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
      items.push({
        memberId: m.id,
        kind: "loan",
        loanId: loan.id,
        amount: Math.round(installment * 100) / 100,
      });
    }
  }
  items.push(...(await commodityDraftItems(coopId)));
  if (items.length === 0) {
    return {
      ok: false,
      message: `Nothing to collect for ${period} — no member has a monthly deduction set (use *setcommit <code> <amount>*), and nobody is repaying a loan.`,
    };
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
      items: {
        create: items.map((i) => ({
          memberId: i.memberId,
          kind: i.kind,
          loanId: i.loanId ?? null,
          amount: i.amount,
        })),
      },
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

/**
 * Build a draft batch from an uploaded employer file. `rows` are already
 * matched to members (see deduction-ingest.ts). Savings items come from the
 * file; loan-repayment items are added for members with an active loan, exactly
 * as the manual `newbatch` path does.
 */
export async function buildBatchFromRows(
  adminPhone: string,
  rows: Array<{ memberId: string; amount: number }>,
  note?: string,
  source?: { key?: string; name?: string },
): Promise<{ ok: boolean; message: string; ref?: string }> {
  const admin = await prisma.member.findFirst({
    where: { phone: adminPhone, role: { in: ["admin", "superadmin"] } },
    include: { cooperative: true },
  });
  if (!admin) return { ok: false, message: "Admin account not found." };
  const coopId = admin.cooperativeId;
  if (rows.length === 0) return { ok: false, message: "No matched rows to build a batch from." };

  const members = await prisma.member.findMany({
    where: { id: { in: rows.map((r) => r.memberId) }, cooperativeId: coopId },
    include: {
      loans: { where: { status: "disbursed", kind: "cash" }, orderBy: { createdAt: "asc" } },
    },
  });
  const byId = new Map(members.map((m) => [m.id, m]));

  const period = periodOf(new Date());
  const waived = await prisma.deductionWaiver.findMany({
    where: { member: { cooperativeId: coopId }, period },
  });
  const waivedIds = new Set(waived.map((w) => w.memberId));

  const items: DraftItem[] = [];
  for (const r of rows) {
    const m = byId.get(r.memberId);
    if (!m || waivedIds.has(m.id)) continue;
    if (r.amount > 0) items.push({ memberId: m.id, kind: "savings", amount: r.amount });
    const loan = m.loans.find((l) => l.balance > 0);
    if (loan) {
      const installment =
        loan.monthlyPayment && loan.monthlyPayment > 0
          ? Math.min(loan.monthlyPayment, loan.balance)
          : loan.balance;
      items.push({
        memberId: m.id,
        kind: "loan",
        loanId: loan.id,
        amount: Math.round(installment * 100) / 100,
      });
    }
  }
  items.push(...(await commodityDraftItems(coopId)));
  if (items.length === 0) {
    return { ok: false, message: "Nothing to collect after applying waivers." };
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
      sourceFileKey: source?.key ?? null,
      sourceFileName: source?.name ?? null,
      items: {
        create: items.map((i) => ({
          memberId: i.memberId,
          kind: i.kind,
          loanId: i.loanId ?? null,
          amount: i.amount,
        })),
      },
    },
  });

  const savers = new Set(items.filter((i) => i.kind === "savings").map((i) => i.memberId)).size;
  const payers = new Set(items.filter((i) => i.kind === "loan").map((i) => i.memberId)).size;
  return {
    ok: true,
    ref,
    message:
      `📋 Batch *${ref}* built from the uploaded file (${period}).\n` +
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
/**
 * Super admin logs the employer cheque/remittance as received. This is the
 * first half of the money-in lifecycle: the batch is not credited until the
 * amount is reconciled against the actual bank credit.
 */
export async function recordCheque(
  superPhone: string,
  rawRef: string,
  amount: number,
  chequeRef?: string,
): Promise<{ ok: boolean; message: string }> {
  const ref = rawRef.trim().toUpperCase();
  const batch = await prisma.deductionBatch.findUnique({ where: { ref } });
  if (!batch) return { ok: false, message: "Batch not found." };
  if (!(await isSuperPhone(superPhone, batch.cooperativeId))) {
    return { ok: false, message: "Only the *super admin* can record a cheque." };
  }
  if (batch.status !== "submitted") {
    return { ok: false, message: `Batch ${ref} is ${batch.status}, not submitted.` };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Usage: *recordcheque <ref> <amount> [cheque ref]*" };
  }
  const superM = await prisma.member.findFirst({
    where: { phone: superPhone, cooperativeId: batch.cooperativeId },
  });
  await prisma.deductionBatch.update({
    where: { id: batch.id },
    data: {
      status: "cheque_received",
      chequeAmount: amount,
      chequeRef: chequeRef?.trim() || null,
      chequeReceivedAt: new Date(),
      chequeReceivedById: superM?.id ?? null,
    },
  });
  await audit({
    cooperativeId: batch.cooperativeId,
    actorPhone: superPhone,
    actorRole: "superadmin",
    action: "deduction.batch.cheque",
    targetType: "deductionBatch",
    detail: `${ref}: ${formatBalance(amount)}${chequeRef ? ` (${chequeRef})` : ""}`,
  });
  return {
    ok: true,
    message:
      `✅ Cheque for batch *${ref}* recorded (${formatBalance(amount)}).\n` +
      `Once the bank credit clears, reconcile with *reconbatch ${ref} <amount>*.`,
  };
}

/**
 * Reconcile a batch against the amount actually received. Approval is blocked
 * while the reconciled amount is below the batch total.
 */
export async function reconcileBatch(
  superPhone: string,
  rawRef: string,
  amount: number,
  source: "manual" | "webhook" | "statement" = "manual",
  note?: string,
): Promise<{ ok: boolean; message: string }> {
  const ref = rawRef.trim().toUpperCase();
  const batch = await prisma.deductionBatch.findUnique({ where: { ref } });
  if (!batch) return { ok: false, message: "Batch not found." };
  if (!(await isSuperPhone(superPhone, batch.cooperativeId))) {
    return { ok: false, message: "Only the *super admin* can reconcile a batch." };
  }
  if (
    batch.status !== "cheque_received" &&
    batch.status !== "reconciled" &&
    batch.status !== "partially_approved"
  ) {
    return {
      ok: false,
      message: `Batch ${ref} is ${batch.status}; record the cheque first with *recordcheque ${ref} <amount>*.`,
    };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: "Usage: *reconbatch <ref> <amount>*" };
  }
  const shortfall = batch.totalAmount - amount;
  await prisma.deductionBatch.update({
    where: { id: batch.id },
    data: {
      status: "reconciled",
      reconciledAmount: amount,
      reconciledAt: new Date(),
      reconciliationSource: source,
      reconciliationNote: note ?? (shortfall > 0 ? `Short by ${formatBalance(shortfall)}` : null),
    },
  });
  await audit({
    cooperativeId: batch.cooperativeId,
    actorPhone: superPhone,
    actorRole: "superadmin",
    action: "deduction.batch.reconcile",
    targetType: "deductionBatch",
    detail: `${ref}: ${formatBalance(amount)} via ${source}${shortfall > 0 ? ` (short ${formatBalance(shortfall)})` : ""}`,
  });
  if (shortfall > 0) {
    await notifySuperAdmins(
      batch.cooperativeId,
      `⚠️ Batch *${ref}* reconciled short: expected ${formatBalance(batch.totalAmount)}, received ${formatBalance(amount)} (short ${formatBalance(shortfall)}).\n` +
        `Attribute it with *shortbatch ${ref} <member code|all> <amount|all|waive>*, then *approvebatch ${ref}*.`,
    );
    return {
      ok: true,
      message:
        `Batch *${ref}* reconciled with a shortfall of ${formatBalance(shortfall)}.\n` +
        `Attribute it with *shortbatch ${ref} <code|all> <amount|all|waive>*; unattributed amounts are split proportionally on approval.`,
    };
  }
  return {
    ok: true,
    message: `✅ Batch *${ref}* reconciled (${formatBalance(amount)}). Approve with *approvebatch ${ref}*.`,
  };
}

/**
 * System path: auto-reconcile a cheque_received batch when a matching bank
 * credit lands (provider webhook). Matches on the exact expected total.
 */
export async function reconcileFromWebhook(
  cooperativeId: string,
  amount: number,
  reference?: string,
): Promise<{ ok: boolean; message: string }> {
  const batch = await prisma.deductionBatch.findFirst({
    where: { cooperativeId, status: "cheque_received", totalAmount: amount },
    orderBy: { chequeReceivedAt: "asc" },
  });
  if (!batch) return { ok: false, message: "No matching batch." };
  await prisma.deductionBatch.update({
    where: { id: batch.id },
    data: {
      status: "reconciled",
      reconciledAmount: amount,
      reconciledAt: new Date(),
      reconciliationSource: "webhook",
      reconciliationNote: reference ?? null,
    },
  });
  await audit({
    cooperativeId,
    actorPhone: "system",
    actorRole: "system",
    action: "deduction.batch.reconcile",
    targetType: "deductionBatch",
    detail: `${batch.ref}: webhook ${formatBalance(amount)}${reference ? ` (${reference})` : ""}`,
  });
  await notifySuperAdmins(
    cooperativeId,
    `✅ Batch *${batch.ref}* auto-reconciled from a bank credit of ${formatBalance(amount)}. Approve with *approvebatch ${batch.ref}*.`,
  );
  return { ok: true, message: `Reconciled ${batch.ref}.` };
}

/**
 * Reconcile cheque_received batches against an uploaded bank statement. Each
 * statement credit is matched to a batch whose expected total equals it.
 */
export async function reconcileFromStatement(
  cooperativeId: string,
  buffer: Buffer,
  filename: string,
): Promise<{ ok: boolean; message: string; reconciled: string[] }> {
  const { parseDeductionFile } = await import("../lib/deduction-parse/index.js");
  const parsed = await parseDeductionFile(buffer, filename);
  const batches = await prisma.deductionBatch.findMany({
    where: { cooperativeId, status: "cheque_received" },
  });
  const reconciled: string[] = [];
  for (const batch of batches) {
    const match = parsed.rows.find((r) => r.amount === batch.totalAmount);
    if (!match) continue;
    await prisma.deductionBatch.update({
      where: { id: batch.id },
      data: {
        status: "reconciled",
        reconciledAmount: match.amount,
        reconciledAt: new Date(),
        reconciliationSource: "statement",
        reconciliationNote: filename,
      },
    });
    await audit({
      cooperativeId,
      actorPhone: "system",
      actorRole: "system",
      action: "deduction.batch.reconcile",
      targetType: "deductionBatch",
      detail: `${batch.ref}: statement ${formatBalance(match.amount)} (${filename})`,
    });
    reconciled.push(batch.ref);
  }
  if (reconciled.length === 0) {
    return {
      ok: false,
      message: `No cheque_received batch matched a credit in *${filename}*.`,
      reconciled,
    };
  }
  await notifySuperAdmins(
    cooperativeId,
    `✅ Reconciled ${reconciled.length} batch(es) from statement *${filename}*: ${reconciled.join(", ")}.`,
  );
  return {
    ok: true,
    message: `✅ Reconciled ${reconciled.length} batch(es) from *${filename}*: ${reconciled.join(", ")}.`,
    reconciled,
  };
}

/** Payroll line priority when a member's remittance does not cover everything. */
export function priorityRank(kind: string): number {
  if (kind === "loan") return 0;
  if (kind === "commodity") return 1;
  return 2;
}

/**
 * Record who a reconciled shortfall belongs to. `amountKobo` may be an explicit
 * amount, "all" (split proportionally by what each member owes) or "waive".
 */
export async function attributeShortfall(
  superPhone: string,
  rawRef: string,
  memberCode: string,
  amountKobo: number | "all" | "waive",
  reason?: string,
): Promise<{ ok: boolean; message: string }> {
  const ref = rawRef.trim().toUpperCase();
  const batch = await prisma.deductionBatch.findUnique({
    where: { ref },
    include: { items: { include: { member: true } } },
  });
  if (!batch) return { ok: false, message: "Batch not found." };
  if (!(await isSuperPhone(superPhone, batch.cooperativeId))) {
    return { ok: false, message: "Only the *super admin* can attribute a shortfall." };
  }
  const received = batch.reconciledAmount ?? 0;
  const totalShort = Math.max(0, batch.totalAmount - received);
  if (totalShort === 0) return { ok: false, message: `Batch ${ref} was not short.` };
  const superM = await prisma.member.findFirst({
    where: { phone: superPhone, cooperativeId: batch.cooperativeId },
  });

  type Target = { memberId: string; name: string; owed: number };
  let targets: Target[] | null;
  if (memberCode.trim().toLowerCase() === "all") {
    targets = Array.from(new Set(batch.items.map((i) => i.memberId))).map((id) => {
      const item = batch.items.find((i) => i.memberId === id)!;
      const owed = batch.items.filter((i) => i.memberId === id).reduce((s, i) => s + i.amount, 0);
      return { memberId: id, name: item.member.name, owed };
    });
  } else {
    const code = memberCode.trim().toUpperCase();
    const item = batch.items.find((i) => i.member.code.toUpperCase() === code);
    if (item) {
      const owed = batch.items
        .filter((i) => i.memberId === item.memberId)
        .reduce((s, i) => s + i.amount, 0);
      targets = [{ memberId: item.memberId, name: item.member.name, owed }];
    } else {
      // A member with nothing in this batch (e.g. waived this month) can still
      // be named explicitly by a super admin.
      const member = await prisma.member.findFirst({
        where: { cooperativeId: batch.cooperativeId, code },
      });
      targets = member ? [{ memberId: member.id, name: member.name, owed: 0 }] : null;
    }
  }
  if (!targets) return { ok: false, message: "That member is not in this cooperative." };

  let added = 0;
  for (const target of targets) {
    const existing = await prisma.deductionShortfall.findUnique({
      where: { batchId_memberId: { batchId: batch.id, memberId: target.memberId } },
    });
    if (amountKobo === "waive") {
      if (existing) {
        await prisma.deductionShortfall.update({
          where: { id: existing.id },
          data: { status: "waived", attributedById: superM?.id ?? null },
        });
      }
      await audit({
        cooperativeId: batch.cooperativeId,
        actorPhone: superPhone,
        actorRole: "superadmin",
        action: "deduction.shortfall.waived",
        targetType: "deductionBatch",
        targetId: batch.id,
        detail: `${ref}: ${target.name}`,
      });
      continue;
    }
    const proportional = Math.round((totalShort * target.owed) / batch.totalAmount);
    const amount = amountKobo === "all" ? proportional : amountKobo;
    if (amount <= 0) continue;
    await prisma.deductionShortfall.upsert({
      where: { batchId_memberId: { batchId: batch.id, memberId: target.memberId } },
      update: {
        amount,
        status: "open",
        reason: reason ?? existing?.reason ?? null,
        attributedById: superM?.id ?? null,
      },
      create: {
        cooperativeId: batch.cooperativeId,
        batchId: batch.id,
        memberId: target.memberId,
        amount,
        reason: reason ?? null,
        attributedById: superM?.id ?? null,
      },
    });
    added += amount;
  }
  await audit({
    cooperativeId: batch.cooperativeId,
    actorPhone: superPhone,
    actorRole: "superadmin",
    action: "deduction.shortfall.attributed",
    targetType: "deductionBatch",
    targetId: batch.id,
    detail: `${ref}: ${formatBalance(added)} across ${targets.length} member(s)`,
  });
  return {
    ok: true,
    message:
      amountKobo === "waive"
        ? `Shortfall waived for ${targets.length} member(s) on *${ref}*.`
        : `Attributed ${formatBalance(added)} of shortfall on *${ref}* to ${targets.length} member(s).`,
  };
}

/**
 * Move an unpaid deduction item to the next period's draft batch. `amount` can
 * carry just the uncovered remainder when the original item was partly credited.
 */
export async function rollForwardItem(
  batchId: string,
  itemId: string,
  approverId: string,
  amount?: number,
): Promise<{ id: string; batchId: string; amount: number; [key: string]: unknown }> {
  return withTx(async () => {
    const item = await prisma.deductionItem.findUnique({ where: { id: itemId } });
    if (!item) throw new Error("Deduction item not found.");
    if (item.batchId !== batchId) throw new Error("Item does not belong to that batch.");
    if (item.status !== "pending") throw new Error("Only a pending item can be rolled forward.");
    const parent = await prisma.deductionBatch.findUnique({ where: { id: batchId } });
    if (!parent) throw new Error("Batch not found.");
    const [year, month] = parent.ref.split("-").slice(1, 3);
    const next = new Date(Date.UTC(Number(year), Number(month), 1));
    const period = periodOf(next);
    let target = await prisma.deductionBatch.findFirst({
      where: { cooperativeId: parent.cooperativeId, status: "draft" },
      orderBy: { createdAt: "desc" },
    });
    if (!target) {
      target = await prisma.deductionBatch.create({
        data: {
          cooperativeId: parent.cooperativeId,
          ref: `DED-${period}-${Date.now().toString(36).toUpperCase()}`,
          note: `Rolled forward from ${parent.ref}`,
          totalAmount: 0,
          createdById: parent.createdById,
        },
      });
    }
    const rollAmount = amount ?? item.amount;
    const created = await prisma.deductionItem.create({
      data: {
        batchId: target.id,
        memberId: item.memberId,
        kind: item.kind,
        loanId: item.loanId,
        amount: rollAmount,
        rolloverOfItemId: item.id,
      },
    });
    await prisma.deductionItem.update({ where: { id: item.id }, data: { status: "rolled" } });
    await prisma.deductionBatch.update({
      where: { id: target.id },
      data: { totalAmount: { increment: created.amount } },
    });
    await prisma.deductionShortfall.updateMany({
      where: { batchId, memberId: item.memberId, status: "open" },
      data: { status: "rolled", rolledToItemId: created.id },
    });
    void approverId;
    return created;
  });
}

export async function approveBatch(
  superPhone: string,
  rawRef: string,
  _opts?: { partial?: boolean },
): Promise<{ ok: boolean; message: string }> {
  const ref = rawRef.trim().toUpperCase();
  const batch = await prisma.deductionBatch.findUnique({
    where: { ref },
    include: {
      createdBy: true,
      items: { include: { member: { include: { wallet: true } } } },
    },
  });
  if (!batch) return { ok: false, message: "Batch not found." };
  if (!(await isSuperPhone(superPhone, batch.cooperativeId))) {
    return { ok: false, message: "Only the *super admin* can approve deduction batches." };
  }
  if (batch.status !== "reconciled" && batch.status !== "partially_approved") {
    return {
      ok: false,
      message:
        batch.status === "submitted"
          ? `Batch ${ref} must be reconciled before approval. Record the cheque with *recordcheque ${ref} <amount>*, then *reconbatch ${ref} <amount>*.`
          : `Batch ${ref} is ${batch.status}, not reconciled.`,
    };
  }

  const alreadyCredited = batch.items
    .filter((i) => i.status === "credited")
    .reduce((s, i) => s + i.amount, 0);
  const budget = (batch.reconciledAmount ?? 0) - alreadyCredited;
  const pendingTotal = batch.items
    .filter((i) => i.status === "pending")
    .reduce((s, i) => s + i.amount, 0);
  if (budget <= 0 && pendingTotal > 0) {
    return {
      ok: false,
      message: `Batch ${ref} has no reconciled money left to credit. Reconcile a top-up first.`,
    };
  }

  const approver = await prisma.member.findFirst({
    where: { phone: superPhone, cooperativeId: batch.cooperativeId },
  });
  if (!approver) {
    return { ok: false, message: "Only the *super admin* can approve deduction batches." };
  }
  // Maker-checker: the approver must be a different super admin than the maker.
  if (approver.id === batch.createdById) {
    return {
      ok: false,
      message:
        "Maker-checker: a batch must be approved by a *different* super admin than the one who built it.",
    };
  }
  // Maker-checker: the maker's name must have been confirmed by a super admin.
  if (!batch.createdBy.nameVerified) {
    return {
      ok: false,
      message:
        `Maker-checker: *${batch.createdBy.name}*'s name must be confirmed by a super admin ` +
        `before their batch can be approved (use *confirmname ${batch.createdBy.code}*).`,
    };
  }

  type NotifyTarget = {
    phone: string;
    altChannelId: string | null;
    preferredChannel: string | null;
    optedOut: boolean;
  };
  const notifications: Array<{ member: NotifyTarget; text: string }> = [];
  // Members credited via a savings deduction — their first such credit can
  // qualify a pending referral. Qualified AFTER the transaction commits (see below).
  const savingsCredited: Array<{ id: string; cooperativeId: string }> = [];
  let savedCount = 0;
  let repaidCount = 0;
  let totalSaved = 0;
  let totalRepaid = 0;
  let rolledCount = 0;

  const outcome = await withTx(async () => {
    // Atomically claim the batch so two concurrent approvals cannot both credit
    // the same members. Only one caller can move submitted -> approved.
    const claimed = await prisma.deductionBatch.updateMany({
      where: { id: batch.id, status: { in: ["reconciled", "partially_approved"] } },
      data: {
        status: "partially_approved",
        approvedAt: new Date(),
        approvedById: approver?.id ?? null,
      },
    });
    if (claimed.count === 0) {
      return { ok: false as const, message: `Batch ${ref} is already being processed.` };
    }

    const pendingByMember = new Map<string, typeof batch.items>();
    for (const item of batch.items) {
      if (item.status !== "pending") continue;
      const list = pendingByMember.get(item.memberId) ?? [];
      list.push(item);
      pendingByMember.set(item.memberId, list);
    }
    const shortfalls = await prisma.deductionShortfall.findMany({
      where: { batchId: batch.id, status: "open" },
    });
    const shortfallByMember = new Map(shortfalls.map((s) => [s.memberId, s.amount]));

    let remainingBudget = budget;
    for (const [memberId, memberItems] of pendingByMember) {
      const memberTotal = memberItems.reduce((s, i) => s + i.amount, 0);
      const short = shortfallByMember.get(memberId) ?? 0;
      // Priority per member: loan first, then commodity, then savings. Anything
      // the member's attributed shortfall (or the batch budget) cannot cover is
      // rolled into the next period instead of being silently dropped.
      let memberBudget = Math.max(0, Math.min(memberTotal - short, remainingBudget));
      const ordered = [...memberItems].sort((a, b) => priorityRank(a.kind) - priorityRank(b.kind));
      for (const item of ordered) {
        const portion = Math.min(item.amount, memberBudget);
        if (portion > 0) {
          const member = item.member;

          if (item.kind === "savings") {
            await prisma.contribution.create({
              data: {
                amount: portion,
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
                data: { balance: { increment: portion }, totalSaved: { increment: portion } },
              });
            }
            const updatedBalance = (member.wallet?.balance ?? 0) + portion;
            notifications.push({
              member,
              text:
                `🏢 *Payroll Deduction Credited*\n\n` +
                `Your employer deduction of *${formatBalance(portion)}* for batch *${ref}* has been applied to your cooperative savings.\n\n` +
                `• Credited: *${formatBalance(portion)}*\n` +
                `• New Savings Balance: *${formatBalance(updatedBalance)}*\n\n` +
                `Thank you for building your wealth! 🛡️`,
            });
            savingsCredited.push({ id: member.id, cooperativeId: member.cooperativeId });
            savedCount += 1;
            totalSaved += portion;
          } else if (item.loanId) {
            const loan = await prisma.loan.findUnique({ where: { id: item.loanId } });
            if (loan && loan.status === "disbursed" && loan.balance > 0) {
              const applied = Math.min(portion, loan.balance);
              // Guarded atomic decrement — a concurrent repayLoan (which also
              // decrements the balance) must not be overwritten by an absolute write.
              const updated = await prisma.loan.updateMany({
                where: { id: loan.id, status: "disbursed", balance: { gte: applied } },
                data: { balance: { decrement: applied } },
              });
              if (updated.count > 0) {
                const fresh = await prisma.loan.findUnique({ where: { id: loan.id } });
                const newBalance = fresh?.balance ?? 0;
                if (newBalance <= 0) {
                  await prisma.loan.update({ where: { id: loan.id }, data: { status: "paid" } });
                }
                await prisma.loanRepayment.create({ data: { amount: applied, loanId: loan.id } });
                notifications.push({
                  member,
                  text:
                    newBalance <= 0
                      ? `🎉 Loan repayment of ${formatBalance(applied)} received — your loan is now *fully repaid*.`
                      : `📄 Loan repayment of ${formatBalance(applied)} received. Remaining balance: ${formatBalance(newBalance)}.`,
                });
                repaidCount += 1;
                totalRepaid += applied;
              }
            }
          }
          memberBudget -= portion;
          remainingBudget -= portion;
          if (portion < item.amount) {
            await rollForwardItem(batch.id, item.id, approver.id, item.amount - portion);
            rolledCount += 1;
          } else {
            await prisma.deductionItem.update({
              where: { id: item.id },
              data: { status: "credited", creditedAt: new Date() },
            });
          }
        } else {
          await rollForwardItem(batch.id, item.id, approver.id, item.amount);
          rolledCount += 1;
        }
      }
    }

    // If some items didn't fit the reconciled amount, the batch stays open for
    // a later top-up; otherwise it is fully approved.
    const remainingPending = await prisma.deductionItem.count({
      where: { batchId: batch.id, status: "pending" },
    });
    await prisma.deductionBatch.update({
      where: { id: batch.id },
      data: { status: remainingPending === 0 ? "approved" : "partially_approved" },
    });

    await audit({
      cooperativeId: batch.cooperativeId,
      actorPhone: superPhone,
      actorRole: "superadmin",
      action: "deduction.batch.approve",
      targetType: "deductionBatch",
      detail: `${ref}: saved ${formatBalance(totalSaved)} (${savedCount}), repaid ${formatBalance(totalRepaid)} (${repaidCount})${rolledCount > 0 ? `, rolled ${rolledCount}` : ""}`,
    });

    return { ok: true as const };
  });

  if (!outcome.ok) return outcome;

  // Notifications are side effects — send only after the transaction commits.
  for (const n of notifications) {
    await notifyMember(n.member, n.text).catch(() => {});
  }

  // A credited savings deduction is a real money-in contribution: qualify any
  // pending referral for the member. Idempotent; a failure must not break the batch.
  for (const m of savingsCredited) {
    await qualifyReferral(m.cooperativeId, m.id).catch((err) => {
      console.warn("[deductions] referral qualification failed:", err);
    });
  }

  const partial = budget < pendingTotal;
  return {
    ok: true,
    message:
      `✅ Batch *${ref}* ${partial ? "approved with a shortfall" : "approved"}.\n` +
      `• Credited ${formatBalance(totalSaved)} to ${savedCount} member(s)\n` +
      `• Applied ${formatBalance(totalRepaid)} to ${repaidCount} loan(s)\n` +
      (rolledCount > 0
        ? `${rolledCount} unpaid item(s) were rolled into the next period's draft batch.`
        : `Everyone has been notified on their preferred platform.`),
  };
}

export async function rejectBatch(
  superPhone: string,
  rawRef: string,
  reason?: string,
): Promise<{ ok: boolean; message: string }> {
  const ref = rawRef.trim().toUpperCase();
  const batch = await prisma.deductionBatch.findUnique({
    where: { ref },
    include: { createdBy: true },
  });
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
    return {
      ok: false,
      message: "Usage: *setcommit <member code> <amount>* (0 stops the deduction).",
    };
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
  return {
    ok: true,
    message: `✅ ${target.name} is waived for ${period}. They have been notified.`,
  };
}

/** Member view of their own deduction commitment. */
export async function myDeduction(
  phone: string,
  cooperativeId?: string,
): Promise<{ ok: boolean; message: string }> {
  const member = await getMemberByPhone(phone, cooperativeId);
  if (!member)
    return {
      ok: false,
      message: "You need to join a cooperative first. Reply *join <code>* to get started.",
    };

  const fresh = await prisma.member.findUnique({
    where: { id: member.id },
    include: { loans: { where: { status: "disbursed" } }, deductionWaivers: true },
  });
  const lines: string[] = ["📌 *Your monthly deduction*", ""];
  lines.push(
    `• Savings commitment: ${fresh?.monthlyDeduction ? formatBalance(fresh.monthlyDeduction) : "_not set_"}`,
  );
  const loan = fresh?.loans.find((l) => l.balance > 0);
  if (loan) {
    const next =
      loan.monthlyPayment && loan.monthlyPayment > 0
        ? Math.min(loan.monthlyPayment, loan.balance)
        : loan.balance;
    lines.push(
      `• Loan repayment: ${formatBalance(next)}/month (${formatBalance(loan.balance)} left)`,
    );
  }
  const period = periodOf(new Date());
  if (fresh?.deductionWaivers.some((w) => w.period === period)) {
    lines.push(`• Waived for ${period} 🎉`);
  }
  return { ok: true, message: lines.join("\n") };
}

/** Member asks to skip this month — pings admins to confirm. */
export async function requestMonthWaiver(
  phone: string,
  cooperativeId?: string,
): Promise<{ ok: boolean; message: string }> {
  const member = await getMemberByPhone(phone, cooperativeId);
  if (!member)
    return {
      ok: false,
      message: "You need to join a cooperative first. Reply *join <code>* to get started.",
    };
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
