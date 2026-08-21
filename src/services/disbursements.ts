import { prisma } from "../lib/prisma.js";
import { sendText } from "../lib/messaging.js";
import { resolveProvider } from "./payments/index.js";
import { formatBalance } from "./cooperative.js";
import { recordLedger } from "./ledger.js";
import { postJournal } from "./journal.js";

export interface DisbursementResult {
  ok: boolean;
  status: "successful" | "failed" | "name_mismatch";
  message: string;
}

interface SendToBankOpts {
  memberId: string;
  amount: number;
  bankAccountNumber: string;
  bankCode: string;
  bankName?: string;
  note: string;
  /**
   * Deterministic idempotency key (e.g. TFR-LOAN-<loanId>). The same key can
   * never pay out twice — provider retries and double-invocations are blocked
   * by the unique constraint on Payout.idempotencyKey.
   */
  idempotencyKey?: string;
  /** Overrides the success message/notification (e.g. for loan wording). */
  successMessage?: string;
  /** Skip account-name verification (death-claim payouts to family members). */
  skipNameCheck?: boolean;
  /** Extra error context to store on the loan (if any) when it fails */
  onFailure?: (status: string, error: string) => Promise<void>;
}

/**
 * Verify the account holder's name against the member's registered name, then
 * send the money. Shared by loan disbursements and member withdrawals.
 * On success a payout record is created. The caller deducts wallets.
 */
export async function sendToBank(opts: SendToBankOpts): Promise<DisbursementResult> {
  const member = await prisma.member.findUnique({ where: { id: opts.memberId } });
  if (!member) return { ok: false, status: "failed", message: "Member not found." };

  const provider = resolveProvider();
  if (!provider.resolveAccount) {
    if (opts.skipNameCheck) {
      return payOut(opts, member, null);
    }
    const msg = "Payment provider has no account resolver — can't verify the bank account.";
    await opts.onFailure?.("failed", "provider has no resolver");
    await notify(member, msg);
    return { ok: false, status: "failed", message: msg };
  }

  // 1. Verify the account holder's name matches the member's registered name.
  const resolved = await provider.resolveAccount({
    accountNumber: opts.bankAccountNumber,
    bankCode: opts.bankCode,
  });
  if (opts.skipNameCheck) {
    // Death claims etc. — the money goes to a family member, not the account
    // holder. Security comes from the validations + super admin approval.
    return payOut(opts, member, resolved.ok ? (resolved.name ?? null) : null);
  }
  if (!resolved.ok || !resolved.name) {
    const msg = `Not paid out: could not verify the account (${resolved.error ?? "unknown error"}). Check the bank details.`;
    await opts.onFailure?.("failed", resolved.error ?? "resolution failed");
    await notify(member, msg);
    return { ok: false, status: "failed", message: msg };
  }

  if (!namesMatch(resolved.name, member.name)) {
    const msg = `Not paid out: the account name (*${resolved.name}*) does not match your registered name (*${member.name}*). Admin must verify before paying.`;
    await opts.onFailure?.("name_mismatch", `account name is "${resolved.name}"`);
    await notify(member, msg);
    return { ok: false, status: "name_mismatch", message: msg };
  }

  // 2. Names match — send the money.
  return payOut(opts, member, resolved.name);
}

async function payOut(
  opts: SendToBankOpts,
  member: { id: string; name: string; cooperativeId: string; phone: string },
  verifiedName: string | null,
): Promise<DisbursementResult> {
  const provider = resolveProvider();
  // Deterministic reference: retries reuse the SAME key, so the provider and
  // our own unique constraint both reject a second execution.
  const reference = opts.idempotencyKey ?? `TFR-${opts.memberId.slice(-8)}-${Date.now()}`;

  // Idempotency gate — if this logical operation already paid, stop here.
  const existing = await prisma.payout.findUnique({ where: { idempotencyKey: reference } });
  if (existing) {
    return {
      ok: false,
      status: "failed",
      message: `Duplicate payout blocked: reference ${reference.slice(-10)} was already processed (${existing.status}).`,
    };
  }

  try {
    let providerRef: string | undefined;
    if (provider.payout) {
      const result = await provider.payout({
        amount: opts.amount,
        bankAccountNumber: opts.bankAccountNumber,
        bankCode: opts.bankCode,
        recipientName: member.name,
        reference,
      });
      if (!result.ok) {
        const msg = `Not paid out: provider error (${result.error ?? "unknown"}). No money moved.`;
        await opts.onFailure?.("failed", result.error ?? "payout failed");
        await notify(member, msg);
        return { ok: false, status: "failed", message: msg };
      }
      providerRef = result.providerRef;
    }

    try {
      await prisma.payout.create({
        data: {
          amount: opts.amount,
          reference,
          idempotencyKey: reference,
          status: "successful",
          provider: provider.name,
          providerRef,
          note: opts.note,
          memberId: member.id,
          cooperativeId: member.cooperativeId,
        },
      });
    } catch (err: any) {
      if (err?.code === "P2002") {
        // Lost the race with a concurrent identical payout — treat as duplicate.
        console.error(`[payout] duplicate blocked for ${reference}`);
        return {
          ok: false,
          status: "failed",
          message: "Duplicate payout blocked (already processed). No second payment was made.",
        };
      }
      throw err;
    }

    // Double-entry: expense leaves the cooperative bank account.
    await postJournal({
      cooperativeId: member.cooperativeId,
      txRef: `PAYOUT-${reference}`,
      description: opts.note,
      postings: [
        { account: "expense:payout", direction: "DEBIT", amount: opts.amount },
        { account: "assets:bank", direction: "CREDIT", amount: opts.amount },
      ],
    }).catch((err) => console.error("[payout] journal failed", err));

    const msg = opts.successMessage ?? `✅ ${formatBalance(opts.amount)} sent to your bank account (${opts.bankName ?? opts.bankCode} ****${opts.bankAccountNumber.slice(-4)}). Ref: ${reference.slice(-6)}.`;
    await notify(member, msg);
    return { ok: true, status: "successful", message: msg };
  } catch (err: any) {
    const msg = `Could not pay out right now (${err?.message ?? "provider error"}). No money moved.`;
    await opts.onFailure?.("failed", err?.message ?? "payout threw");
    await notify(member, msg);
    return { ok: false, status: "failed", message: msg };
  }
}

/**
 * Disburse an approved loan to the member's bank account.
 *
 * The provider resolves the account holder's name and we compare it against
 * the member's registered name. If the names don't match, the money is NOT
 * sent — the loan stays approved but un-disbursed so an admin can follow up.
 */
export async function disburseLoan(loanId: string): Promise<DisbursementResult> {
  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
    include: { member: true },
  });
  if (!loan) return { ok: false, status: "failed", message: "Loan not found." };
  if (loan.status !== "approved") {
    return { ok: false, status: "failed", message: `Loan must be approved before disbursement (current: ${loan.status}).` };
  }

  // ATOMIC CLAIM — flips disbursementStatus to "processing" only if no other
  // caller is mid-flight and it hasn't already succeeded. Two racing retries
  // can never both reach the provider. (NULL disbursementStatus must match
  // explicitly — SQL NOT IN never matches NULL.)
  const claimed = await prisma.loan.updateMany({
    where: {
      id: loan.id,
      status: "approved",
      OR: [
        { disbursementStatus: null },
        { disbursementStatus: { notIn: ["successful", "processing"] } },
      ],
    },
    data: { disbursementStatus: "processing" },
  });
  if (claimed.count === 0) {
    return {
      ok: false,
      status: "failed",
      message: `Loan *${loan.id.slice(-6)}* is already disbursing or was paid out — check *loans* before retrying.`,
    };
  }

  const { member } = loan;

  if (!loan.bankAccountNumber || !loan.bankCode) {
    const msg = `Loan *${loan.id.slice(-6)}* is approved but has no bank details, so nothing was paid out.`;
    await prisma.loan.update({
      where: { id: loan.id },
      data: { disbursementStatus: "failed", disbursementError: "missing bank details" },
    });
    await notify(member, msg);
    return { ok: false, status: "failed", message: msg };
  }

  // The member receives the loan minus the flat admin charge.
  const adminCharge = loan.adminCharge ?? 0;
  const disbursable = Math.max(0, loan.amount - adminCharge);

  const result = await sendToBank({
    memberId: member.id,
    amount: disbursable,
    bankAccountNumber: loan.bankAccountNumber,
    bankCode: loan.bankCode,
    bankName: loan.bankName ?? undefined,
    note: `Loan disbursement to ${member.name}`,
    // Deterministic per-loan key: a retried disbursement of THIS loan can
    // never pay out twice, even across app restarts.
    idempotencyKey: `TFR-LOAN-${loan.id}`,
    successMessage: `🎉 Loan *disbursed!* ${formatBalance(loan.amount)} approved — *${formatBalance(disbursable)}* (after the ${formatBalance(adminCharge)} admin charge) is on its way to your ${loan.bankName ?? loan.bankCode} account ****${loan.bankAccountNumber.slice(-4)}.`,
    onFailure: async (status, error) => {
      // "failed" is retryable; the next attempt re-claims via the gate above.
      await prisma.loan.update({
        where: { id: loan.id },
        data: { disbursementStatus: status, disbursementError: error },
      });
    },
  });

  if (result.ok) {
    // Defensive final claim — even if two paths somehow reached here, only
    // the one that flips the status books the ledger entry.
    const finalized = await prisma.loan.updateMany({
      where: { id: loan.id, status: "approved" },
      data: {
        status: "disbursed",
        disbursedAt: new Date(),
        disbursementStatus: "successful",
        disbursementAmount: disbursable,
        disbursementError: null,
      },
    });
    if (finalized.count === 0) {
      console.error(`[loan] disbursement succeeded but loan ${loan.id} was already finalized`);
      return result;
    }
    // P&L: the admin charge is cooperative income.
    await recordLedger({
      cooperativeId: loan.cooperativeId,
      type: "income",
      category: "admin_charge",
      amount: adminCharge,
      note: `Admin charge on loan ${loan.id.slice(-6)}`,
      reference: loan.id,
    });
    return {
      ok: true,
      status: "successful",
      message: `🎉 Loan *disbursed!* ${formatBalance(loan.amount)} approved — *${formatBalance(disbursable)}* (after the ${formatBalance(adminCharge)} admin charge) is on its way to your ${loan.bankName ?? loan.bankCode} account ****${loan.bankAccountNumber.slice(-4)}.`,
    };
  }
  return result;
}

/** Loose first+last name match: case-insensitive, ignoring punctuation/middle words. */
export function namesMatch(accountName: string, registeredName: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const a = new Set(norm(accountName).split(" ").filter(Boolean));
  const b = new Set(norm(registeredName).split(" ").filter(Boolean));
  // Every word in the registered name must appear in the account name.
  for (const word of b) {
    if (!a.has(word)) return false;
  }
  return a.size > 0;
}

async function notify(member: { phone: string }, text: string): Promise<void> {
  await sendText({ to: member.phone, text }).catch(() => {});
}