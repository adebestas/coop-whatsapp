import { PrismaClient } from '@prisma/client';
import { CubeCoverClient } from './cubecover';
import { enqueueAfterCommit } from '../deferred';

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
    enqueueAfterCommit(() => {
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