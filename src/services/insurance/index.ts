import { PrismaClient } from '@prisma/client';
import { CubeCoverClient } from './cubecover';
import { prisma } from '../../lib/prisma.js';
// The REAL deferred-send queue (src/lib/deferred.ts). Note: there is a legacy
// no-op stub at src/services/deferred.ts — importing that would silently drop
// the deferred premium debit, so it must never be used here.
import { enqueueAfterCommit } from '../../lib/deferred.js';

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

  async purchasePlan(cooperativeId: string, memberId: string, productCode: string, planCode: string) {
    const quote = await this.cubecover.createQuote({ productCode, planCode, memberId });
    const policy = await this.cubecover.purchasePolicy({
      quoteId: quote.quoteId,
      memberId,
      paymentRef: `insurance_${Date.now()}`,
    });

    const newPolicy = await this.prisma.insurancePolicy.create({
      data: {
        cooperativeId,
        memberId,
        productCode,
        planCode,
        premiumKobo: quote.premiumKobo,
        coverageKobo: policy.coverageKobo || 0,
        cubecoverPolicyId: policy.id,
        startDate: new Date(policy.startDate),
        endDate: policy.endDate ? new Date(policy.endDate) : undefined,
      },
    });

    // Defer premium deduction outside transaction
    enqueueAfterCommit(async () => {
      // TODO: Deduct premium from member wallet
    });

    return newPolicy;
  }

  async getMemberPolicy(cooperativeId: string, memberId: string) {
    return this.prisma.insurancePolicy.findFirst({
      where: { cooperativeId, memberId, status: 'active' },
    });
  }

  async cancelPolicy(cooperativeId: string, policyId: string) {
    const policy = await this.prisma.insurancePolicy.findFirst({
      where: { id: policyId, cooperativeId },
    });
    if (!policy) throw new Error('Policy not found');
    await this.cubecover.cancelPolicy(policy.cubecoverPolicyId!);
    return this.prisma.insurancePolicy.update({
      where: { id: policyId },
      data: { status: 'cancelled' },
    });
  }

  async renewPolicy(cooperativeId: string, policyId: string) {
    const policy = await this.prisma.insurancePolicy.findFirst({
      where: { id: policyId, cooperativeId },
    });
    if (!policy) throw new Error('Policy not found');
    const renewed = await this.cubecover.renewPolicy(policy.cubecoverPolicyId!);
    return this.prisma.insurancePolicy.update({
      where: { id: policyId },
      data: {
        status: 'active',
        startDate: new Date(renewed.startDate),
        endDate: renewed.endDate ? new Date(renewed.endDate) : undefined,
      },
    });
  }

  async submitClaim(cooperativeId: string, memberId: string, policyId: string, claimType: string, amountKobo: number, description?: string, documents?: string[]) {
    const policy = await this.prisma.insurancePolicy.findFirst({
      where: { id: policyId, cooperativeId, memberId, status: 'active' },
    });
    if (!policy) throw new Error('Active policy not found');
    const claim = await this.cubecover.submitClaim({
      policyId: policy.cubecoverPolicyId!,
      claimType,
      amountKobo,
      description,
      documents,
    });
    return this.prisma.insuranceClaim.create({
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
  }

  async getClaim(cooperativeId: string, claimId: string) {
    return this.prisma.insuranceClaim.findFirst({
      where: { id: claimId, cooperativeId },
    });
  }

  async listClaims(cooperativeId: string, memberId: string) {
    return this.prisma.insuranceClaim.findMany({
      where: { cooperativeId, memberId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async handleWebhook(event: string, data: Record<string, unknown>) {
    switch (event) {
      case 'policy.created':
      case 'policy.renewed':
        await this.prisma.insurancePolicy.updateMany({
          where: { cubecoverPolicyId: data.id as string },
          data: { status: 'active' },
        });
        break;
      case 'policy.cancelled':
        await this.prisma.insurancePolicy.updateMany({
          where: { cubecoverPolicyId: data.id as string },
          data: { status: 'cancelled' },
        });
        break;
      case 'claim.approved':
        await this.prisma.insuranceClaim.updateMany({
          where: { cubecoverClaimId: data.id as string },
          data: { status: 'approved', processedAt: new Date() },
        });
        break;
      case 'claim.paid':
        await this.prisma.insuranceClaim.updateMany({
          where: { cubecoverClaimId: data.id as string },
          data: { status: 'paid', paidAt: new Date() },
        });
        break;
      case 'claim.rejected':
        await this.prisma.insuranceClaim.updateMany({
          where: { cubecoverClaimId: data.id as string },
          data: { status: 'rejected', processedAt: new Date() },
        });
        break;
    }
  }
}

// ===== Admin claim actions (used by admin-actions.ts WhatsApp commands) =====

/** Approve a claim for payout (admin override; CubeCover is notified separately). */
export async function approveInsuranceClaim(claimId: string): Promise<{ message: string }> {
  const claim = await prisma.insuranceClaim.findUnique({ where: { id: claimId } });
  if (!claim) return { message: `No insurance claim found with id *${claimId}*.` };
  if (claim.status === 'approved' || claim.status === 'paid') {
    return { message: `Claim *${claimId}* is already ${claim.status}.` };
  }
  await prisma.insuranceClaim.update({
    where: { id: claimId },
    data: { status: 'approved', processedAt: new Date() },
  });
  return { message: `✅ Claim *${claimId}* approved for payout.` };
}

/** Reject a claim. */
export async function rejectInsuranceClaim(claimId: string): Promise<{ message: string }> {
  const claim = await prisma.insuranceClaim.findUnique({ where: { id: claimId } });
  if (!claim) return { message: `No insurance claim found with id *${claimId}*.` };
  if (claim.status === 'rejected') {
    return { message: `Claim *${claimId}* is already rejected.` };
  }
  await prisma.insuranceClaim.update({
    where: { id: claimId },
    data: { status: 'rejected', processedAt: new Date() },
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
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  if (!claims.length) {
    return { message: `No insurance claims for *${member.name}* (${memberCode}).` };
  }
  const lines = claims.map(
    (c) =>
      `• *${c.id.slice(0, 8)}* — ${c.claimType}, ₦${(c.amountKobo / 100).toFixed(0)} — ${c.status}`,
  );
  return { message: `*Insurance claims for ${member.name}*\n\n${lines.join('\n')}` };
}