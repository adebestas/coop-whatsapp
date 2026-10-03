import { prisma, withTx } from "./prisma.js";
import { withDeferredSends } from "./deferred.js";

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
 *
 * Inside `fn`, the exported `prisma` proxy routes every query to this
 * transaction (see src/lib/prisma.ts), so callers do not need to thread `tx`.
 */
export async function withCoopContext<T>(
  cooperativeId: string,
  fn: (tx: typeof prisma) => Promise<T>,
): Promise<T> {
  // Sends are deferred until after the transaction commits, so the transaction
  // covers only DB work (never the WhatsApp/Telegram network calls or pacing).
  return withDeferredSends(() =>
    withTx(async (tx) => {
      await setCoopContext(tx as never, cooperativeId);
      return fn(tx as unknown as typeof prisma);
    }),
  );
}

/**
 * Resolve the cooperative that owns a phone number, BEFORE any RLS context is
 * set. On Postgres this calls the SECURITY DEFINER resolver
 * `app.resolve_coop_by_phone` (see prisma/migrations/20261006000000_rls_resolvers),
 * which bypasses RLS. Returns null when the phone is unknown OR ambiguous
 * (registered in more than one cooperative) — fail-closed, matching
 * getMemberByPhone().
 *
 * On SQLite (local dev + `npm test`) there is no RLS, so it resolves directly.
 */
export async function resolveCoopByPhone(phone: string): Promise<string | null> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) {
    const rows = await prisma.member.findMany({
      where: { phone },
      select: { cooperativeId: true },
      take: 2,
    });
    return rows.length === 1 ? rows[0].cooperativeId : null;
  }
  const rows = await prisma.$queryRaw<{ coop: string | null }[]>`
    SELECT app.resolve_coop_by_phone(${phone}) AS coop
  `;
  return rows[0]?.coop ?? null;
}

/**
 * Resolve the cooperative that owns an alternate channel id (e.g. a linked
 * Telegram id). Same fail-closed semantics as resolveCoopByPhone.
 */
export async function resolveCoopByAltChannel(channel: string): Promise<string | null> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) {
    const rows = await prisma.member.findMany({
      where: { altChannelId: channel },
      select: { cooperativeId: true },
      take: 2,
    });
    return rows.length === 1 ? rows[0].cooperativeId : null;
  }
  const rows = await prisma.$queryRaw<{ coop: string | null }[]>`
    SELECT app.resolve_coop_by_alt_channel(${channel}) AS coop
  `;
  return rows[0]?.coop ?? null;
}

export interface CoopChoice {
  id: string;
  name: string;
  code: string;
}

/**
 * List every cooperative a phone belongs to. On Postgres this calls the
 * SECURITY DEFINER resolver `app.resolve_coops_by_phone` (bypasses RLS); on
 * SQLite it queries directly. Returns [] for an unknown phone.
 */
export async function resolveCoopsByPhone(phone: string): Promise<CoopChoice[]> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) {
    const rows = await prisma.member.findMany({
      where: { phone },
      select: { cooperativeId: true, cooperative: { select: { name: true, code: true } } },
    });
    return rows.map((r) => ({
      id: r.cooperativeId,
      name: r.cooperative.name,
      code: r.cooperative.code,
    }));
  }
  return prisma.$queryRaw<CoopChoice[]>`
    SELECT id, name, code FROM app.resolve_coops_by_phone(${phone})
  `;
}
