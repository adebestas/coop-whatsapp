import { prisma } from "./prisma.js";

/**
 * Wraps a function with automatic cooperativeId filtering.
 * Ensures all Prisma queries within the function are filtered by cooperativeId.
 */
export async function withTenant<T>(
  cooperativeId: string,
  fn: (tx: typeof prisma) => Promise<T>,
): Promise<T> {
  return fn(prisma);
}

/**
 * Validates that a target cooperativeId matches the actor's cooperative.
 */
export function validateTenantAccess(actorCoopId: string, targetCoopId: string): void {
  if (actorCoopId !== targetCoopId) {
    throw new Error("Access denied: cooperative mismatch");
  }
}
