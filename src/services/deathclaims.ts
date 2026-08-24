import { prisma } from "../lib/prisma.js";
import { sendText } from "../lib/messaging.js";
import { formatBalance } from "./cooperative.js";
import { sendToBank } from "./disbursements.js";
import { resolveBankCode } from "../lib/banks.js";
import { audit } from "./audit.js";

/** Number of validations (by guarantors) a death claim needs. */
export const REQUIRED_DEATH_VALIDATIONS = 2;

export interface ClaimResult {
  ok: boolean;
  message: string;
  claimId?: string;
}

async function findClaim(shortId: string) {
  // Try exact match first
  const exact = await prisma.deathClaim.findUnique({
    where: { id: shortId },
    include: { member: true, validations: true },
  });
  if (exact) return exact;

  // Try suffix match — require exactly one result
  const matches = await prisma.deathClaim.findMany({
    where: { id: { endsWith: shortId } },
    include: { member: true, validations: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Open a death claim for a member (admin/super admin). The member is marked
 * deceased and the bot asks for the death certificate.
 */
export async function startDeathClaim(actorPhone: string, memberCode: string): Promise<ClaimResult> {
  const actor = await prisma.member.findFirst({ where: { phone: actorPhone } });
  if (!actor) return { ok: false, message: "You need to join a cooperative first." };

  const deceased = await prisma.member.findFirst({
    where: { code: memberCode.trim().toUpperCase(), cooperativeId: actor.cooperativeId },
    include: { wallet: true },
  });
  if (!deceased) {
    return { ok: false, message: `No member with code *${memberCode}* in your cooperative.` };
  }
  if (deceased.status === "deceased") {
    const existing = await prisma.deathClaim.findFirst({
      where: { memberId: deceased.id, status: { notIn: ["paid", "rejected"] } },
    });
    if (existing) {
      return { ok: false, message: `A death claim (*${existing.id.slice(-6)}*) is already open for ${deceased.name}.` };
    }
  }

  const claim = await prisma.$transaction(async (tx) => {
    await tx.member.update({ where: { id: deceased.id }, data: { status: "deceased" } });
    return tx.deathClaim.create({
      data: {
        memberId: deceased.id,
        cooperativeId: actor.cooperativeId,
        status: "awaiting_certificate",
        createdById: actor.id,
      },
    });
  });

  await audit({
    cooperativeId: actor.cooperativeId,
    actorPhone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "claim.open",
    targetType: "deathclaim",
    targetId: claim.id,
    detail: `for ${deceased.name}`,
  });

  return {
    ok: true,
    claimId: claim.id,
    message:
      `🕯️ Death claim *${claim.id.slice(-6)}* opened for *${deceased.name}* (balance: ${formatBalance(deceased.wallet?.balance ?? 0)}).\n\n` +
      `Now send the *death certificate* — a photo, document, or the reference details.`,
  };
}

/** Attach the uploaded certificate to the claim and open it for validation. */
export async function submitCertificate(claimId: string, certificateRef: string): Promise<ClaimResult> {
  const claim = await findClaim(claimId);
  if (!claim) return { ok: false, message: "Death claim not found." };
  if (claim.status !== "awaiting_certificate") {
    return { ok: false, message: `This claim is already ${claim.status}.` };
  }

  await prisma.deathClaim.update({
    where: { id: claim.id },
    data: { status: "awaiting_validation", certificateRef },
  });

  // The deceased's own guarantors are asked to validate; if they don't cover
  // two slots any active member may step in (enforced in validateClaim).
  return {
    ok: true,
    message:
      `✅ Death certificate received for claim *${claim.id.slice(-6)}* (${claim.member.name}).\n\n` +
      `*${REQUIRED_DEATH_VALIDATIONS} guarantors* must now validate it by replying:\n` +
      `*validate ${claim.id.slice(-6)}*\n\n` +
      `After validation, set the family's bank with *claimbank ${claim.id.slice(-6)} <account> <bank>*, then the super admin approves with *approveclaim ${claim.id.slice(-6)}*.`,
  };
}

/** A member validates a death claim. The deceased's guarantors come first. */
export async function validateClaim(phone: string, claimCode: string): Promise<ClaimResult> {
  const validator = await prisma.member.findFirst({ where: { phone } });
  if (!validator) return { ok: false, message: "You need to join a cooperative first." };

  const claim = await findClaim(claimCode);
  if (!claim || claim.cooperativeId !== validator.cooperativeId) {
    return { ok: false, message: "Death claim not found in your cooperative." };
  }
  if (claim.status !== "awaiting_validation") {
    return { ok: false, message: `This claim is ${claim.status} — validation is closed.` };
  }
  if (claim.validations.some((v) => v.memberId === validator.id)) {
    return { ok: false, message: "You already validated this claim." };
  }

  // Prefer the guarantors who vouched for the deceased's loans.
  const guarantors = await prisma.guarantor.findMany({
    where: { loan: { memberId: claim.memberId }, status: "confirmed" },
    select: { memberId: true },
  });
  const allowed = new Set(guarantors.map((g) => g.memberId));
  if (allowed.size >= REQUIRED_DEATH_VALIDATIONS && !allowed.has(validator.id)) {
    return {
      ok: false,
      message: `Only the guarantors of ${claim.member.name}'s loans can validate this claim.`,
    };
  }

  await prisma.deathValidation.create({
    data: { claimId: claim.id, memberId: validator.id },
  });

  const count = claim.validations.length + 1;
  if (count < REQUIRED_DEATH_VALIDATIONS) {
    return {
      ok: true,
      message: `Thank you. Validation *${count}/${REQUIRED_DEATH_VALIDATIONS}* recorded for claim *${claim.id.slice(-6)}*.`,
    };
  }

  await prisma.deathClaim.update({ where: { id: claim.id }, data: { status: "validated" } });
  return {
    ok: true,
    message:
      `✅ Claim *${claim.id.slice(-6)}* is now *validated* by ${REQUIRED_DEATH_VALIDATIONS} guarantors.\n\n` +
      `Next: an admin sets the family's bank account with\n` +
      `*claimbank ${claim.id.slice(-6)} <account number> <bank>*\n` +
      `then the super admin pays out with *approveclaim ${claim.id.slice(-6)}*.`,
  };
}

/** Set the family's bank account for the payout (admin/super admin). */
export async function setClaimBank(
  actorPhone: string,
  claimCode: string,
  accountNumber: string,
  bankInput: string,
): Promise<ClaimResult> {
  const actor = await prisma.member.findFirst({ where: { phone: actorPhone } });
  if (!actor || !["admin", "superadmin"].includes(actor.role)) {
    return { ok: false, message: "Only an admin can set the family's bank account." };
  }

  const claim = await findClaim(claimCode);
  if (!claim || claim.cooperativeId !== actor.cooperativeId) {
    return { ok: false, message: "Death claim not found in your cooperative." };
  }
  if (["paid", "rejected"].includes(claim.status)) {
    return { ok: false, message: `This claim is already ${claim.status}.` };
  }

  const account = accountNumber.replace(/[^0-9]/g, "");
  if (!/^\d{10}$/.test(account)) {
    return { ok: false, message: "Account numbers are 10 digits, e.g. *claimbank ABC123 0123456789 Access*." };
  }
  const bank = resolveBank(bankInput);
  if (!bank) {
    return { ok: false, message: "We don't recognise that bank. Try e.g. *Access*, *GTB*, *Zenith*, or the 5-digit bank code." };
  }

  await prisma.deathClaim.update({
    where: { id: claim.id },
    data: { familyAccountNumber: account, familyBankCode: bank.code, familyBankName: bank.name },
  });
  return {
    ok: true,
    message: `Family bank saved for claim *${claim.id.slice(-6)}*: ${bank.name} ****${account.slice(-4)}.\n\nThe *super admin* can now pay out with *approveclaim ${claim.id.slice(-6)}*.`,
  };
}

/** Super admin's final approval — pays the deceased's balance to the family. */
export async function approveClaim(actorPhone: string, claimCode: string): Promise<ClaimResult> {
  const actor = await prisma.member.findFirst({ where: { phone: actorPhone } });
  if (!actor) return { ok: false, message: "You need to join a cooperative first." };

  const claim = await findClaim(claimCode);
  if (!claim || claim.cooperativeId !== actor.cooperativeId) {
    return { ok: false, message: "Death claim not found in your cooperative." };
  }

  const isSuper = actor.role === "superadmin" || (await isSuperAdminOf(actor.phone, claim.cooperativeId));
  if (!isSuper) {
    return { ok: false, message: "Only the cooperative's super admin can give the final approval on a death claim." };
  }
  if (claim.status === "paid") return { ok: false, message: "This claim was already paid." };
  if (claim.status === "processing") {
    return { ok: false, message: "This claim payout is already in progress — wait for it to settle." };
  }
  if (claim.status !== "validated") {
    return { ok: false, message: `The claim must be validated by ${REQUIRED_DEATH_VALIDATIONS} guarantors first (current: ${claim.status}).` };
  }
  // Dual-control: nobody approves a payout on their own wallet.
  if (actor.id === claim.memberId) {
    return { ok: false, message: "⛔ You can't approve a death claim on your own account." };
  }
  if (!claim.familyAccountNumber || !claim.familyBankCode) {
    return { ok: false, message: `Set the family's bank first: *claimbank ${claim.id.slice(-6)} <account> <bank>*.` };
  }

  const wallet = await prisma.wallet.findUnique({ where: { memberId: claim.memberId } });
  const balance = wallet?.balance ?? 0;
  if (balance <= 0) {
    await prisma.deathClaim.update({ where: { id: claim.id }, data: { status: "paid", finalizedAt: new Date() } });
    return { ok: true, message: `No balance left in ${claim.member.name}'s wallet. Claim *${claim.id.slice(-6)}* closed as paid.` };
  }

  // ATOMIC CLAIM — exactly one super drives the payout; concurrent calls stop here.
  const claimed = await prisma.deathClaim.updateMany({
    where: { id: claim.id, status: "validated" },
    data: { status: "processing" },
  });
  if (claimed.count === 0) {
    return { ok: false, message: "This claim was just picked up by another approval — check its state." };
  }

  try {
    // Debit BEFORE paying — no balance, no transfer.
    const debited = await prisma.wallet.updateMany({
      where: { id: wallet!.id, balance: { gte: balance } },
      data: { balance: { decrement: balance } },
    });
    if (debited.count === 0) {
      await prisma.deathClaim.updateMany({
        where: { id: claim.id, status: "processing" },
        data: { status: "validated" },
      });
      return { ok: false, message: "Balance changed during payout — claim NOT closed. Investigate immediately." };
    }

    const result = await sendToBank({
      memberId: claim.memberId,
      amount: balance,
      bankAccountNumber: claim.familyAccountNumber,
      bankCode: claim.familyBankCode,
      bankName: claim.familyBankName ?? undefined,
      note: `Death claim payout to family of ${claim.member.name}`,
      skipNameCheck: true, // the money goes to the family, not the account holder
      idempotencyKey: `TFR-CLAIM-${claim.id}`,
    });
    if (!result.ok) {
      // Refund and hand back for retry.
      await prisma.$transaction([
        prisma.wallet.update({ where: { id: wallet!.id }, data: { balance: { increment: balance } } }),
        prisma.deathClaim.updateMany({
          where: { id: claim.id, status: "processing" },
          data: { status: "validated" },
        }),
      ]);
      return { ok: false, message: `Payout failed (wallet refunded): ${result.message}` };
    }

    await prisma.deathClaim.updateMany({
      where: { id: claim.id, status: "processing" },
      data: { status: "paid", approvedAt: new Date(), finalizedAt: new Date() },
    });

    await audit({
      cooperativeId: claim.cooperativeId,
      actorPhone,
      actorId: actor.id,
      actorRole: "superadmin",
      action: "claim.payout",
      targetType: "deathclaim",
      targetId: claim.id,
      detail: `${formatBalance(balance)} to family of ${claim.member.name}`,
    });

    return {
      ok: true,
      message: `🕊️ *${formatBalance(balance)}* paid to the family of ${claim.member.name} (${claim.familyBankName ?? claim.familyBankCode} ****${claim.familyAccountNumber.slice(-4)}). Claim *${claim.id.slice(-6)}* closed.`,
    };
  } catch (err: any) {
    // Crash safety — restore funds and hand the claim back for retry.
    if (wallet) {
      await prisma.wallet
        .updateMany({ where: { id: wallet.id }, data: { balance: { increment: balance } } })
        .catch(() => {});
    }
    await prisma.deathClaim
      .updateMany({
        where: { id: claim.id, status: "processing" },
        data: { status: "validated" },
      })
      .catch(() => {});
    console.error(`[claim] payout threw, refunded: ${claim.id}`, err);
    return { ok: false, message: `Claim payout failed and the wallet was refunded (${String(err?.message ?? err).slice(0, 120)}).` };
  }
}

export async function rejectClaim(actorPhone: string, claimCode: string): Promise<ClaimResult> {
  const actor = await prisma.member.findFirst({ where: { phone: actorPhone } });
  if (!actor || !["admin", "superadmin"].includes(actor.role)) {
    return { ok: false, message: "Only an admin can reject a death claim." };
  }
  const claim = await findClaim(claimCode);
  if (!claim || claim.cooperativeId !== actor.cooperativeId) {
    return { ok: false, message: "Death claim not found in your cooperative." };
  }
  if (claim.status === "paid") return { ok: false, message: "This claim was already paid." };
  await prisma.deathClaim.update({ where: { id: claim.id }, data: { status: "rejected" } });
  await audit({
    cooperativeId: claim.cooperativeId,
    actorPhone,
    actorId: actor.id,
    actorRole: actor.role,
    action: "claim.reject",
    targetType: "deathclaim",
    targetId: claim.id,
    detail: `for ${claim.member.name}`,
  });
  return { ok: true, message: `Death claim *${claim.id.slice(-6)}* for ${claim.member.name} was rejected.` };
}

function resolveBank(input: string): { code: string; name: string } | null {
  return resolveBankCode(input);
}

async function isSuperAdminOf(phone: string, cooperativeId: string): Promise<boolean> {
  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });
  return coop?.adminPhone === phone;
}
