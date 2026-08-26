/**
 * Safe short ID resolution. When users enter partial IDs (e.g., 6-char slices),
 * this function ensures the partial ID resolves to exactly one record.
 * Returns the full ID if unique, null if not found or ambiguous.
 */

import { prisma } from "./prisma.js";

type ModelName = "withdrawalRequest" | "loan" | "externalPayment" | "deathClaim" | "purchasePoll";

/**
 * Resolve a short/partial ID to a full ID, ensuring uniqueness.
 * Returns { id, ambiguous } where ambiguous is true if multiple records match.
 */
export async function resolveShortId(
  model: ModelName,
  shortId: string,
  where?: Record<string, unknown>,
): Promise<{ id: string; ambiguous: boolean } | null> {
  // First try exact match
  const exact = await (prisma as any)[model].findFirst({
    where: { id: shortId, ...where },
    select: { id: true },
  });
  if (exact) return { id: exact.id, ambiguous: false };

  // Try suffix match (most common user pattern — last N chars)
  const matches = await (prisma as any)[model].findMany({
    where: { id: { endsWith: shortId }, ...where },
    select: { id: true },
    take: 2,
  });

  if (matches.length === 0) return null;
  if (matches.length === 1) return { id: matches[0].id, ambiguous: false };

  // Multiple matches — ambiguous
  return null; // Caller should show "be more specific" message
}

/**
 * Same as resolveShortId but throws a user-friendly error if not found/ambiguous.
 */
export async function requireShortId(
  model: ModelName,
  shortId: string,
  entityName: string,
  where?: Record<string, unknown>,
): Promise<string> {
  const result = await resolveShortId(model, shortId, where);
  if (!result) {
    throw new Error(`${entityName} not found. Use the full ID or be more specific.`);
  }
  return result.id;
}
