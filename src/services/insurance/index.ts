import { PrismaClient } from "@prisma/client";
import { CubeCoverClient } from "./cubecover";
import { prisma, withTx } from "../../lib/prisma.js";
import { setCoopContext } from "../../lib/tenant-context.js";
import { postJournal } from "../journal.js";
import { audit } from "../audit.js";
import { formatBalance } from "../../lib/money.js";

export interface InsuranceServiceConfig {
  prisma: PrismaClient;
  cubecover: CubeCoverClient;
}

export class InsuranceService {
  private prisma: PrismaClient;
  private cubecover: CubeCoverClient;

  constructor(config: InsuranceServiceConfig) {
    this.prisma = config.prisma;
    this.cubecover = config.cubecover;
  }

  async getProducts() {
    return this.cubecover.getProducts();
  }

  /**
   * Charge a premium from the member's wallet. Guarded atomic decrement so the
   * balance can never go negative, plus a balanced journal entry. Throws
   * INSUFFICIENT_BALANCE / NO_WALLET when the member cannot pay.
   */
  private async chargePremium(
    cooperativeId: string,
    memberId: string,
    amount: number,
    ref: string,
    description: string,
  ): Promise<void> {
    const wallet = await this.prisma.wallet.findUnique({ where: { memberId } });
    if (!wallet) throw new Error("NO_WALLET");
    if (wallet.balance < amount) throw new Error("INSUFFICIENT_BALANCE");

    await withTx(async (tx) => {
      await setCoopContext(tx as never, cooperativeId);
      const claimed = await tx.wallet.updateMany({
        where: { id: wallet.id, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (claimed.count === 0) throw new Error("INSUFFICIENT_BALANCE");
      const posted = await postJournal(
        {
          cooperativeId,
          txRef: `insurance_premium_${ref}`,
          description,
          postings: [
            { account: `member_wallet:${wallet.id}`, direction: "DEBIT", amount, memberId },
            { account: "income:insurance_premium", direction: "CREDIT", amount, memberId },
          ],
        },
        tx as never,
      );
      if (!posted.posted) throw new Error(`insurance premium journal not posted: ${posted.reason}`);
    });
  }

  /** Reverse a premium charge (used when the provider call fails after debit). */
  private async refundPremium(
    cooperativeId: string,
    memberId: string,
    amount: number,
    ref: string,
  ): Promise<void> {
    const wallet = await this.prisma.wallet.findUnique({ where: { memberId } });
    if (!wallet) return;
    await withTx(async (tx) => {
      await setCoopContext(tx as never, cooperativeId);
      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: amount } },
      });
      await postJournal(
        {
          cooperativeId,
          txRef: `insurance_premium_refund_${ref}`,
          description: `Insurance premium refund ${formatBalance(amount)}`,
          postings: [
            { account: "income:insurance_premium", direction: "DEBIT", amount, memberId },
            { account: `member_wallet:${wallet.id}`, direction: "CREDIT", amount, memberId },
          ],
        },
        tx as never,
      );
    });
  }

  async purchasePlan(
    cooperativeId: string,
    memberId: string,
    productCode: string,
    planCode: string,
  ) {
    // One active policy per member per product — prevents duplicate purchases.
    const existing = await this.prisma.insurancePolicy.findFirst({
      where: { cooperativeId, memberId, productCode, status: "active" },
    });
    if (existing) throw new Error("ALREADY_INSURED");

    const quote = await this.cubecover.createQuote({ productCode, planCode, memberId });
    const premium = quote.premiumKobo;
    const paymentRef = `insurance_${cooperativeId}_${memberId}_${productCode}_${planCode}`;

    // Debit FIRST so a policy can never be created without payment.
    await this.chargePremium(
      cooperativeId,
      memberId,
      premium,
      paymentRef,
      `Insurance premium ${formatBalance(premium)} (${productCode}/${planCode})`,
    );

    let policy;
    try {
      policy = await this.cubecover.purchasePolicy({
        quoteId: quote.quoteId,
        memberId,
        paymentRef,
      });
    } catch (err) {
      // Provider failed — make the member whole before surfacing the error.
      await this.refundPremium(cooperativeId, memberId, premium, paymentRef);
      throw err;
    }

    const newPolicy = await this.prisma.insurancePolicy.create({
      data: {
        cooperativeId,
        memberId,
        productCode,
        planCode,
        premiumKobo: premium,
        coverageKobo: policy.coverageKobo || 0,
        cubecoverPolicyId: policy.id,
        startDate: new Date(policy.startDate),
        endDate: policy.endDate ? new Date(policy.endDate) : undefined,
      },
    });

    const member = await this.prisma.member.findUnique({
      where: { id: memberId },
      select: { phone: true },
    });
    await audit({
      cooperativeId,
      actorPhone: member?.phone ?? memberId,
      actorId: memberId,
      action: "insurance.purchase",
      targetType: "insurance_policy",
      targetId: newPolicy.id,
      amount: premium,
      detail: `${productCode}/${planCode} policy ${policy.id}`,
    });

    return newPolicy;
  }

  async getMemberPolicy(cooperativeId: string, memberId: string) {
    return this.prisma.insurancePolicy.findFirst({
      where: { cooperativeId, memberId, status: "active" },
    });
  }

  async cancelPolicy(cooperativeId: string, policyId: string) {
    const policy = await this.prisma.insurancePolicy.findFirst({
      where: { id: policyId, cooperativeId },
    });
    if (!policy) throw new Error("Policy not found");
    if (!policy.cubecoverPolicyId) throw new Error("Policy has no provider id");
    await this.cubecover.cancelPolicy(policy.cubecoverPolicyId);
    const updated = await this.prisma.insurancePolicy.update({
      where: { id: policyId },
      data: { status: "cancelled" },
    });
    await audit({
      cooperativeId,
      actorPhone: policy.memberId,
      actorId: policy.memberId,
      action: "insurance.cancel",
      targetType: "insurance_policy",
      targetId: policyId,
      detail: `cancelled policy ${policy.cubecoverPolicyId}`,
    });
    return updated;
  }

  async renewPolicy(cooperativeId: string, policyId: string) {
    const policy = await this.prisma.insurancePolicy.findFirst({
      where: { id: policyId, cooperativeId },
    });
    if (!policy) throw new Error("Policy not found");
    if (!policy.cubecoverPolicyId) throw new Error("Policy has no provider id");

    const premium = policy.premiumKobo;
    const paymentRef = `insurance_renew_${policyId}_${Date.now()}`;
    await this.chargePremium(
      cooperativeId,
      policy.memberId,
      premium,
      paymentRef,
      `Insurance renewal ${formatBalance(premium)}`,
    );

    let renewed;
    try {
      renewed = await this.cubecover.renewPolicy(policy.cubecoverPolicyId);
    } catch (err) {
      await this.refundPremium(cooperativeId, policy.memberId, premium, paymentRef);
      throw err;
    }

    const updated = await this.prisma.insurancePolicy.update({
      where: { id: policyId },
      data: {
        status: "active",
        startDate: new Date(renewed.startDate),
        endDate: renewed.endDate ? new Date(renewed.endDate) : undefined,
      },
    });
    await audit({
      cooperativeId,
      actorPhone: policy.memberId,
      actorId: policy.memberId,
      action: "insurance.renew",
      targetType: "insurance_policy",
      targetId: policyId,
      amount: premium,
      detail: `renewed policy ${policy.cubecoverPolicyId}`,
    });
    return updated;
  }

  async submitClaim(
    cooperativeId: string,
    memberId: string,
    policyId: string,
    claimType: string,
    amountKobo: number,
    description?: string,
    documents?: string[],
  ) {
    const policy = await this.prisma.insurancePolicy.findFirst({
      where: { id: policyId, cooperativeId, memberId, status: "active" },
    });
    if (!policy) throw new Error("Active policy not found");
    if (!policy.cubecoverPolicyId) throw new Error("Policy has no provider id");
    if (amountKobo <= 0) throw new Error("INVALID_AMOUNT");
    if (amountKobo > policy.coverageKobo) throw new Error("EXCEEDS_COVERAGE");

    const claim = await this.cubecover.submitClaim({
      policyId: policy.cubecoverPolicyId,
      claimType,
      amountKobo,
      description,
      documents,
    });
    const created = await this.prisma.insuranceClaim.create({
      data: {
        cooperativeId,
        memberId,
        policyId,
        claimType,
        amountKobo,
        cubecoverClaimId: claim.id,
        description,
        documents: documents || [],
      },
    });
    await audit({
      cooperativeId,
      actorPhone: memberId,
      actorId: memberId,
      action: "insurance.claim.submit",
      targetType: "insurance_claim",
      targetId: created.id,
      amount: amountKobo,
      detail: `${claimType} claim ${claim.id}`,
    });
    return created;
  }

  async getClaim(cooperativeId: string, claimId: string) {
    return this.prisma.insuranceClaim.findFirst({
      where: { id: claimId, cooperativeId },
    });
  }

  async listClaims(cooperativeId: string, memberId: string) {
    return this.prisma.insuranceClaim.findMany({
      where: { cooperativeId, memberId },
      orderBy: { createdAt: "desc" },
    });
  }

  async handleWebhook(event: string, data: Record<string, unknown>) {
    // A missing id would make Prisma drop the filter and update EVERY row.
    const id = typeof data.id === "string" ? data.id : null;
    if (!id) {
      console.warn(`[insurance] webhook ${event} missing data.id — ignored`);
      return;
    }
    switch (event) {
      case "policy.created":
      case "policy.renewed":
        await this.prisma.insurancePolicy.updateMany({
          where: { cubecoverPolicyId: id },
          data: { status: "active" },
        });
        break;
      case "policy.cancelled":
        await this.prisma.insurancePolicy.updateMany({
          where: { cubecoverPolicyId: id },
          data: { status: "cancelled" },
        });
        break;
      case "claim.approved":
        await this.prisma.insuranceClaim.updateMany({
          where: { cubecoverClaimId: id },
          data: { status: "approved", processedAt: new Date() },
        });
        break;
      case "claim.paid":
        await payoutInsuranceClaim(id);
        break;
      case "claim.rejected":
        await this.prisma.insuranceClaim.updateMany({
          where: { cubecoverClaimId: id },
          data: { status: "rejected", processedAt: new Date() },
        });
        break;
    }
  }
}

// ===== Claim payout (shared by the webhook and the admin override) =====

/**
 * Credit a paid claim to the member's wallet, post the journal entry, and mark
 * the claim paid. Idempotent: a claim already paid is a no-op.
 */
export async function payoutInsuranceClaim(
  cubecoverClaimId: string,
): Promise<{ ok: boolean; message: string }> {
  const claim = await prisma.insuranceClaim.findFirst({ where: { cubecoverClaimId } });
  if (!claim) return { ok: false, message: `No claim for provider id *${cubecoverClaimId}*.` };
  if (claim.status === "paid") return { ok: true, message: `Claim *${claim.id}* already paid.` };

  const payout = claim.payoutKobo ?? claim.amountKobo;
  const wallet = await prisma.wallet.findUnique({ where: { memberId: claim.memberId } });
  if (!wallet) return { ok: false, message: `No wallet for member *${claim.memberId}*.` };

  await withTx(async (tx) => {
    await setCoopContext(tx as never, claim.cooperativeId);
    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: payout } },
    });
    const posted = await postJournal(
      {
        cooperativeId: claim.cooperativeId,
        txRef: `insurance_claim_payout_${claim.id}`,
        description: `Insurance claim payout ${formatBalance(payout)}`,
        postings: [
          {
            account: "expense:insurance_claim",
            direction: "DEBIT",
            amount: payout,
            memberId: claim.memberId,
          },
          {
            account: `member_wallet:${wallet.id}`,
            direction: "CREDIT",
            amount: payout,
            memberId: claim.memberId,
          },
        ],
      },
      tx as never,
    );
    if (!posted.posted)
      throw new Error(`insurance claim payout journal not posted: ${posted.reason}`);
    await tx.insuranceClaim.update({
      where: { id: claim.id },
      data: { status: "paid", paidAt: new Date() },
    });
  });

  await audit({
    cooperativeId: claim.cooperativeId,
    actorPhone: claim.memberId,
    actorId: claim.memberId,
    action: "insurance.claim.paid",
    targetType: "insurance_claim",
    targetId: claim.id,
    amount: payout,
    detail: `claim ${cubecoverClaimId} paid to wallet`,
  });
  return { ok: true, message: `✅ Claim *${claim.id}* paid (${formatBalance(payout)}).` };
}

// ===== Admin claim actions (used by admin-actions.ts WhatsApp commands) =====

/** Approve a claim and pay it out to the member's wallet. */
export async function approveInsuranceClaim(claimId: string): Promise<{ message: string }> {
  const claim = await prisma.insuranceClaim.findUnique({ where: { id: claimId } });
  if (!claim) return { message: `No insurance claim found with id *${claimId}*.` };
  if (claim.status === "paid") return { message: `Claim *${claimId}* is already paid.` };
  if (!claim.cubecoverClaimId) {
    return { message: `Claim *${claimId}* has no provider id — cannot pay out.` };
  }
  const result = await payoutInsuranceClaim(claim.cubecoverClaimId);
  return { message: result.message };
}

/** Reject a claim. */
export async function rejectInsuranceClaim(claimId: string): Promise<{ message: string }> {
  const claim = await prisma.insuranceClaim.findUnique({ where: { id: claimId } });
  if (!claim) return { message: `No insurance claim found with id *${claimId}*.` };
  if (claim.status === "rejected") {
    return { message: `Claim *${claimId}* is already rejected.` };
  }
  await prisma.insuranceClaim.update({
    where: { id: claimId },
    data: { status: "rejected", processedAt: new Date() },
  });
  return { message: `Claim *${claimId}* rejected.` };
}

/** List the most recent insurance claims for a member (by member code). */
export async function listMemberInsuranceClaims(memberCode: string): Promise<{ message: string }> {
  const member = await prisma.member.findFirst({
    where: { code: memberCode },
    select: { id: true, name: true },
  });
  if (!member) return { message: `No member found with code *${memberCode}*.` };
  const claims = await prisma.insuranceClaim.findMany({
    where: { memberId: member.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  if (!claims.length) {
    return { message: `No insurance claims for *${member.name}* (${memberCode}).` };
  }
  const lines = claims.map(
    (c) => `• *${c.id.slice(0, 8)}* — ${c.claimType}, ${formatBalance(c.amountKobo)} — ${c.status}`,
  );
  return { message: `*Insurance claims for ${member.name}*\n\n${lines.join("\n")}` };
}
