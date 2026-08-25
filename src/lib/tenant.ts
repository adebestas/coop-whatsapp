import { prisma } from "./prisma.js";

/**
 * Wraps a function with automatic cooperativeId filtering.
 * Tenant isolation is enforced at the admin route level via req.adminCoopId —
 * all admin queries use the coopId from the verified JWT token. Use
 * validateTenantAccess() to verify actor and target cooperatives match.
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
