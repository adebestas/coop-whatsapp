/**
 * Normalisers for thrown values. `catch` binds `unknown`, and provider/Prisma
 * errors are not always `Error` instances — these keep `error` strings stable.
 */

/** Prisma unique-constraint violation (duplicate delivery or insert). */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/** Render a thrown value for logs, alerts and user-facing messages. */
export function errorMessage(err: unknown, fallback = "unknown"): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return fallback;
}
