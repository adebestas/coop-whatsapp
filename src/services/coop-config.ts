import { prisma } from "../lib/prisma.js";
import { cacheGet, cacheSet, cacheDel } from "../lib/cache.js";
import { getRule } from "../lib/rule-registry.js";
import { loadPlatformPolicyRows, platformPolicyVersion } from "./platform-policy-store.js";

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
  pendingDividendRate: number | null;
  lastDividendRate: number | null;
  nextAGMDate: Date | null;
  literacyCertificationEnabled: boolean;
  literacyQuizPassMark: number;
  literacyQuizQuestionCount: number;
  certifiedLoanBoost: number;
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
  pendingDividendRate: null,
  lastDividendRate: null,
  nextAGMDate: null,
  literacyCertificationEnabled: true,
  literacyQuizPassMark: 4,
  literacyQuizQuestionCount: 6,
  certifiedLoanBoost: 1,
};

export async function getCoopConfig(cooperativeId: string): Promise<CoopConfig> {
  // Fold the platform-policy version into the key: a policy write bumps the
  // version, so every cached coop-config entry is invalidated at once.
  const cacheKey = `coopconfig:${cooperativeId}:v${platformPolicyVersion()}`;
  const cached = await cacheGet<CoopConfig>(cacheKey);
  if (cached) return cached;

  const config = await prisma.cooperativeConfig.findUnique({
    where: { cooperativeId },
  });

  const base: CoopConfig = config
    ? {
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
        pendingDividendRate: (config as any).pendingDividendRate ?? null,
        lastDividendRate: (config as any).lastDividendRate ?? null,
        nextAGMDate: (config as any).nextAGMDate ?? null,
        literacyCertificationEnabled:
          (config as any).literacyCertificationEnabled ??
          DEFAULT_CONFIG.literacyCertificationEnabled,
        literacyQuizPassMark:
          (config as any).literacyQuizPassMark ?? DEFAULT_CONFIG.literacyQuizPassMark,
        literacyQuizQuestionCount:
          (config as any).literacyQuizQuestionCount ?? DEFAULT_CONFIG.literacyQuizQuestionCount,
        certifiedLoanBoost: (config as any).certifiedLoanBoost ?? DEFAULT_CONFIG.certifiedLoanBoost,
      }
    : { ...DEFAULT_CONFIG };

  // Always run the platform layer, including the "no row" path, so a coop with
  // no config row still picks up the platform policy. `base` is a copy, never
  // the shared DEFAULT_CONFIG, so the result is safe to cache and mutate.
  const result = await applyPlatformPolicy(base, config !== null);

  await cacheSet(cacheKey, result, CACHE_TTL);
  return result;
}

/**
 * Overlay the platform policy (defaults, bounds, lock) on top of a coop's base
 * config.
 *
 * `coopConfigured` distinguishes "the coop has a stored config row" from the
 * fallback DEFAULT_CONFIG. Without it the resolution could not tell a genuine
 * coop override from a default, and a coop with no row would never pick up a
 * platform value (Requirement: "a coop with no config row must still pick up a
 * platform policy default"). When the coop has no row, coop values are treated
 * as unset and the platform value / rule default wins.
 *
 * With zero PlatformPolicy rows this is a no-op that returns `{ ...base }`, so
 * the output is identical to the pre-platform behaviour.
 */
async function applyPlatformPolicy(base: CoopConfig, coopConfigured: boolean): Promise<CoopConfig> {
  const policies = await loadPlatformPolicyRows();
  const out = { ...base } as Record<string, unknown>;
  for (const [key, pol] of Object.entries(policies)) {
    const rule = getRule(key);
    if (!rule) continue;
    const platVal = pol.value === undefined ? rule.default : pol.value;
    const coopVal = coopConfigured ? (base as unknown as Record<string, unknown>)[key] : undefined;
    let value: unknown = pol.locked ? platVal : coopVal !== undefined ? coopVal : platVal;
    if (typeof value === "number") value = clamp(value, pol.min ?? rule.min, pol.max ?? rule.max);
    if (rule.type === "bool") value = Boolean(value);
    out[key] = value;
  }
  return out as unknown as CoopConfig;
}

// Defined locally (not imported from platform-policy.ts) to avoid a circular import.
function clamp(n: number, min?: number | null, max?: number | null): number {
  if (min !== null && min !== undefined && n < min) return min;
  if (max !== null && max !== undefined && n > max) return max;
  return n;
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
  await cacheDel(`coopconfig:${cooperativeId}:v${platformPolicyVersion()}`);
  return getCoopConfig(cooperativeId);
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
