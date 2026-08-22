import { prisma } from "../lib/prisma.js";

/**
 * New-payee cooling period. The first time a cooperative pays a bank account,
 * it enters a holding window (default 24h). Account-takeover fraud wants
 * same-day movement — this kills that window while being invisible for
 * established payees.
 *
 * Hold hours come from NEW_BENEFICIARY_HOLD_HOURS (0 disables; defaults to 0
 * under NODE_ENV=test so existing flows stay deterministic).
 */

export function beneficiaryHoldMs(): number {
  const raw = process.env.NEW_BENEFICIARY_HOLD_HOURS;
  const hours = raw !== undefined && raw !== "" ? Number(raw) : process.env.NODE_ENV === "test" ? 0 : 24;
  return Math.max(0, hours) * 60 * 60 * 1000;
}

export interface BeneficiaryCheck {
  ok: boolean;
  message?: string;
}

/**
 * Register (or recognize) a payee. Returns blocked=true while the account is
 * inside its first-time holding window.
 */
export async function ensureBeneficiaryAllowed(opts: {
  cooperativeId: string;
  memberId?: string | null;
  accountNumber: string;
  bankCode: string;
  bankName?: string | null;
}): Promise<BeneficiaryCheck> {
  const holdMs = beneficiaryHoldMs();
  if (!opts.accountNumber || !opts.bankCode) return { ok: true };
  if (holdMs === 0) {
    // Keep the record even when the hold is disabled — history is useful and
    // enabling the hold later shouldn't treat known payees as new.
    await prisma.beneficiary.upsert({
      where: {
        cooperativeId_accountNumber_bankCode: {
          cooperativeId: opts.cooperativeId,
          accountNumber: opts.accountNumber,
          bankCode: opts.bankCode,
        },
      },
      create: {
        cooperativeId: opts.cooperativeId,
        memberId: opts.memberId ?? null,
        accountNumber: opts.accountNumber,
        bankCode: opts.bankCode,
        bankName: opts.bankName ?? null,
      },
      update: { bankName: opts.bankName ?? undefined },
    });
    return { ok: true };
  }

  const existing = await prisma.beneficiary.findUnique({
    where: {
      cooperativeId_accountNumber_bankCode: {
        cooperativeId: opts.cooperativeId,
        accountNumber: opts.accountNumber,
        bankCode: opts.bankCode,
      },
    },
  });

  if (existing) {
    const age = Date.now() - existing.createdAt.getTime();
    if (age < holdMs) {
      // Inside the first-use window. Same member or not — account takeover
      // usually comes FROM the account owner's own chat session.
      const hoursLeft = Math.max(1, Math.ceil((holdMs - age) / (60 * 60 * 1000)));
      return {
        ok: false,
        message:
          `⏳ This bank account was added *${Math.floor(age / (60 * 60 * 1000))}h ago* and is still in its ${Math.round(holdMs / (60 * 60 * 1000))}-hour safety window — about *${hoursLeft}h* left.\n\n` +
          `This protects your money if someone gains access to this chat. A super admin can verify the details to release it sooner.`,
      };
    }
    return { ok: true };
  }

  await prisma.beneficiary.create({
    data: {
      cooperativeId: opts.cooperativeId,
      memberId: opts.memberId ?? null,
      accountNumber: opts.accountNumber,
      bankCode: opts.bankCode,
      bankName: opts.bankName ?? null,
    },
  });

  return {
    ok: false,
    message:
      `⏳ New bank account detected. For your protection, first-time accounts wait *24 hours* before receiving money — this protects you if someone hijacks an account.\n\n` +
      `Try again tomorrow, or ask the super admin to verify the details.`,
  };
}
