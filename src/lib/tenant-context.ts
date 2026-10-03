import { prisma } from "./prisma.js";

/**
 * Set the Row-Level-Security tenant GUC on the CURRENT transaction.
 *
 * Postgres-only: SQLite (local dev + `npm test`) has no session GUC, so this is
 * a deliberate no-op there. `set_config(..., true)` is transaction-local, so it
 * cannot leak across pooled connections.
 *
 * With the policies in `prisma/rls/recommended_policies.sql` applied, every
 * query in the same transaction is automatically restricted to this
 * cooperative's rows.
 */
export async function setCoopContext(
  tx: { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number> },
  cooperativeId: string,
): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) return; // SQLite: no GUC support
  await tx.$executeRaw`SELECT set_config('app.current_cooperative_id', ${cooperativeId}, true)`;
}

/**
 * Run `fn` inside a transaction scoped to a single cooperative's RLS context.
 * This is the reference integration point for the staged RLS activation: wire
 * tenant-scoped service work through this helper, then flip the policies on.
 */
export async function withCoopContext<T>(
  cooperativeId: string,
  fn: (tx: typeof prisma) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await setCoopContext(tx as never, cooperativeId);
    return fn(tx as unknown as typeof prisma);
  });
}
