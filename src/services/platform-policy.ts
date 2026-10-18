// src/services/platform-policy.ts
import { prisma } from "../lib/prisma.js";
import { getRule, RULE_KEYS } from "../lib/rule-registry.js";
import { getCoopConfig, type CoopConfig } from "./coop-config.js";
import { loadPlatformPolicyRows, clearPlatformPolicyCache } from "./platform-policy-store.js";

export { clearPlatformPolicyCache };

/**
 * The platform policy catalogue: EVERY registry rule, each merged with its
 * override row when one exists and its registry defaults otherwise. Spec §8
 * requires /policies to list platform rules (value/min/max/locked), not only
 * the keys an operator has already overridden.
 */
export async function listPlatformPolicies() {
  const overrides = await loadPlatformPolicyRows();
  return RULE_KEYS.map((key) => {
    const rule = getRule(key);
    const row = overrides[key];
    return {
      key,
      value: row?.value,
      min: row?.min ?? rule?.min ?? null,
      max: row?.max ?? rule?.max ?? null,
      locked: row?.locked ?? false,
      rule,
    };
  });
}

export function clamp(n: number, min?: number | null, max?: number | null): number {
  if (min !== null && min !== undefined && n < min) return min;
  if (max !== null && max !== undefined && n > max) return max;
  return n;
}

export async function setPlatformPolicy(
  key: string,
  input: { value?: number | boolean | string; min?: number; max?: number; locked?: boolean },
): Promise<void> {
  const rule = getRule(key);
  if (!rule) throw new Error(`unknown rule: ${key}`);
  const min = input.min ?? rule.min ?? null;
  const max = input.max ?? rule.max ?? null;
  if (min !== null && min !== undefined && max !== null && max !== undefined && min > max)
    throw new Error(`min > max for ${key}`);
  await prisma.platformPolicy.upsert({
    where: { key },
    create: {
      key,
      value: input.value === undefined ? null : JSON.stringify(input.value),
      min,
      max,
      locked: input.locked ?? false,
    },
    update: {
      ...(input.value === undefined ? {} : { value: JSON.stringify(input.value) }),
      ...(input.min === undefined ? {} : { min }),
      ...(input.max === undefined ? {} : { max }),
      ...(input.locked === undefined ? {} : { locked: input.locked }),
    },
  });
  clearPlatformPolicyCache(); // bumps the version -> all coop-config keys miss
}

/** Single resolution path: defer to getCoopConfig, then report provenance per key. */
export async function getEffectiveConfig(coopId: string): Promise<{
  config: CoopConfig;
  meta: Record<string, { source: "platform" | "coop"; locked: boolean }>;
}> {
  const config = await getCoopConfig(coopId);
  // Provenance comes from the coop's RAW stored row, not the resolved config:
  // getCoopConfig fills every policy key, so a defined resolved value cannot
  // signal whether the coop actually stored it.
  const row = await prisma.cooperativeConfig.findUnique({ where: { cooperativeId: coopId } });
  const raw = row as unknown as Record<string, unknown> | null;
  const policies = await loadPlatformPolicyRows();
  const meta: Record<string, { source: "platform" | "coop"; locked: boolean }> = {};
  for (const [key, pol] of Object.entries(policies)) {
    if (!getRule(key)) continue;
    const hasCoopValue = raw !== null && raw[key] !== undefined && raw[key] !== null;
    meta[key] = { source: !pol.locked && hasCoopValue ? "coop" : "platform", locked: pol.locked };
  }
  return { config, meta };
}
