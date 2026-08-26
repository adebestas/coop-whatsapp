import { prisma } from "../lib/prisma.js";
import { cacheGet, cacheSet, cacheDel } from "../lib/cache.js";

const CACHE_TTL = 300; // 5 minutes

export interface CoopConfig {
  loanInterestRate: number;
  serviceChargePercent: number;
  minContribution: number;
  minSavings: number;
  minWithdrawal: number;
  maxWithdrawal: number;
  withdrawalCooldownMonths: number;
  lateFinePercent: number;
  maxLoanMultiplier: number;
  autoApproveLoans: boolean;
  requireGuarantors: boolean;
  minGuarantors: number;
  largeTxThreshold: number;
  reportingThreshold: number;
}

export interface BrandingConfig {
  displayName: string;
  welcomeMessage: string | null;
  footerText: string | null;
  logoUrl: string | null;
}

export interface SubscriptionConfig {
  plan: string;
  status: string;
  memberLimit: number;
  monthlyPrice: number;
  currentPeriodEnd: Date | null;
}

const DEFAULT_CONFIG: CoopConfig = {
  loanInterestRate: 10,
  serviceChargePercent: 2,
  minContribution: 200000,
  minSavings: 100000,
  minWithdrawal: 500000,
  maxWithdrawal: 5000000,
  withdrawalCooldownMonths: 6,
  lateFinePercent: 5,
  maxLoanMultiplier: 3,
  autoApproveLoans: false,
  requireGuarantors: true,
  minGuarantors: 2,
  largeTxThreshold: 500_000_000,
  reportingThreshold: 500_000_000,
};

export async function getCoopConfig(cooperativeId: string): Promise<CoopConfig> {
  const cacheKey = `coopconfig:${cooperativeId}`;
  const cached = await cacheGet<CoopConfig>(cacheKey);
  if (cached) return cached;

  const config = await prisma.cooperativeConfig.findUnique({
    where: { cooperativeId },
  });

  if (!config) {
    return DEFAULT_CONFIG;
  }

  const result: CoopConfig = {
    loanInterestRate: config.loanInterestRate,
    serviceChargePercent: config.serviceChargePercent,
    minContribution: config.minContribution,
    minSavings: config.minSavings,
    minWithdrawal: config.minWithdrawal,
    maxWithdrawal: config.maxWithdrawal,
    withdrawalCooldownMonths: config.withdrawalCooldownMonths,
    lateFinePercent: config.lateFinePercent,
    maxLoanMultiplier: config.maxLoanMultiplier,
    autoApproveLoans: config.autoApproveLoans,
    requireGuarantors: config.requireGuarantors,
    minGuarantors: config.minGuarantors,
    largeTxThreshold: (config as any).largeTxThreshold ?? DEFAULT_CONFIG.largeTxThreshold,
    reportingThreshold: (config as any).reportingThreshold ?? DEFAULT_CONFIG.reportingThreshold,
  };

  await cacheSet(cacheKey, result, CACHE_TTL);
  return result;
}

export async function updateCoopConfig(
  cooperativeId: string,
  updates: Partial<CoopConfig>,
): Promise<CoopConfig> {
  await prisma.cooperativeConfig.upsert({
    where: { cooperativeId },
    create: { cooperativeId, ...updates },
    update: updates,
  });
  await cacheDel(`coopconfig:${cooperativeId}`);
  return getCoopConfig(cooperativeId);
}

export async function getBranding(cooperativeId: string): Promise<BrandingConfig> {
  const cacheKey = `branding:${cooperativeId}`;
  const cached = await cacheGet<BrandingConfig>(cacheKey);
  if (cached) return cached;

  const branding = await prisma.brandingConfig.findUnique({
    where: { cooperativeId },
  });

  const coop = await prisma.cooperative.findUnique({ where: { id: cooperativeId } });

  const result: BrandingConfig = {
    displayName: branding?.displayName ?? coop?.name ?? "Coop Bank",
    welcomeMessage: branding?.welcomeMessage ?? null,
    footerText: branding?.footerText ?? null,
    logoUrl: branding?.logoUrl ?? null,
  };

  await cacheSet(cacheKey, result, CACHE_TTL);
  return result;
}

export async function getSubscription(cooperativeId: string): Promise<SubscriptionConfig> {
  const cacheKey = `subscription:${cooperativeId}`;
  const cached = await cacheGet<SubscriptionConfig>(cacheKey);
  if (cached) return cached;

  const sub = await prisma.subscription.findUnique({
    where: { cooperativeId },
  });

  const result: SubscriptionConfig = {
    plan: sub?.plan ?? "free",
    status: sub?.status ?? "active",
    memberLimit: sub?.memberLimit ?? 20,
    monthlyPrice: sub?.monthlyPrice ?? 0,
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
  };

  await cacheSet(cacheKey, result, CACHE_TTL);
  return result;
}

export async function checkLimits(cooperativeId: string): Promise<{
  ok: boolean;
  message?: string;
  memberCount: number;
  memberLimit: number;
}> {
  const sub = await getSubscription(cooperativeId);
  const memberCount = await prisma.member.count({
    where: { cooperativeId, status: "active" },
  });

  // Subscription member limit: warn instead of hard block to avoid blocking
  // registration during grace periods or when the admin is aware of the limit.
  if (memberCount >= sub.memberLimit) {
    return {
      ok: true,
      message: `⚠️ Member limit reached (${memberCount}/${sub.memberLimit} on ${sub.plan} plan). Registration is allowed but consider upgrading to add more members.`,
      memberCount,
      memberLimit: sub.memberLimit,
    };
  }

  return { ok: true, memberCount, memberLimit: sub.memberLimit };
}
