// src/services/platform-policy-store.ts
import { prisma } from "../lib/prisma.js";

export interface PolicyRow {
  value: unknown;
  min: number | null;
  max: number | null;
  locked: boolean;
}

let cache: { at: number; version: number; rows: Record<string, PolicyRow> } | null = null;
let version = 0;
const TTL_MS = 300_000;

/** Monotonic version folded into the coop-config cache key so a policy change invalidates it. */
export function platformPolicyVersion(): number {
  return version;
}

export function clearPlatformPolicyCache(): void {
  version++;
  cache = null;
}

export async function loadPlatformPolicyRows(): Promise<Record<string, PolicyRow>> {
  if (cache && Date.now() - cache.at < TTL_MS && cache.version === version) return cache.rows;
  const rows = await prisma.platformPolicy.findMany();
  const out: Record<string, PolicyRow> = {};
  for (const r of rows) {
    out[r.key] = {
      value: r.value === null ? undefined : JSON.parse(r.value),
      min: r.min,
      max: r.max,
      locked: r.locked,
    };
  }
  cache = { at: Date.now(), version, rows: out };
  return out;
}
