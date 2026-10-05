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

/**
 * List all cooperative IDs. On Postgres this calls the SECURITY DEFINER resolver
 * `app.list_cooperative_ids()` (bypasses RLS); on SQLite it queries directly.
 */
export async function listCooperativeIds(): Promise<string[]> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) {
    const rows = await prisma.cooperative.findMany({ select: { id: true } });
    return rows.map((r) => r.id);
  }
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM app.list_cooperative_ids()
  `;
  return rows.map((r) => r.id);
}

/**
 * Run `fn` once per cooperative, each inside that cooperative's RLS context.
 * For schedulers that must process every tenant.
 */
export async function forEachCoop<T>(fn: (coopId: string) => Promise<T>): Promise<void> {
  const ids = await listCooperativeIds();
  for (const id of ids) {
    await withCoopContext(id, () => fn(id));
  }
}

/**
 * Resolve the cooperative that owns a virtual account number.
 * On Postgres this calls the SECURITY DEFINER resolver `app.resolve_coop_by_virtual_account`;
 * on SQLite it queries directly.
 */
export async function resolveCoopByVirtualAccount(accountNumber: string): Promise<string | null> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) {
    const row = await prisma.member.findFirst({
      where: { virtualAccountNumber: accountNumber },
      select: { cooperativeId: true },
    });
    return row?.cooperativeId ?? null;
  }
  const rows = await prisma.$queryRaw<{ coop: string | null }[]>`
    SELECT app.resolve_coop_by_virtual_account(${accountNumber}) AS coop
  `;
  return rows[0]?.coop ?? null;
}

/**
 * Resolve the cooperative that owns a payout reference.
 */
export async function resolveCoopByPayoutReference(reference: string): Promise<string | null> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) {
    const row = await prisma.payout.findUnique({
      where: { reference },
      select: { cooperativeId: true },
    });
    return row?.cooperativeId ?? null;
  }
  const rows = await prisma.$queryRaw<{ coop: string | null }[]>`
    SELECT app.resolve_coop_by_payout_reference(${reference}) AS coop
  `;
  return rows[0]?.coop ?? null;
}

/**
 * Resolve the cooperative by its join code.
 */
export async function resolveCoopByCode(code: string): Promise<string | null> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) {
    const row = await prisma.cooperative.findUnique({
      where: { code },
      select: { id: true },
    });
    return row?.id ?? null;
  }
  const rows = await prisma.$queryRaw<{ coop: string | null }[]>`
    SELECT app.resolve_coop_by_code(${code}) AS coop
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

/**
 * Report whether RLS is actually ENFORCED for the current database role.
 *
 * "Policies exist" is not the same as "isolation is enforced": the table owner
 * bypasses RLS unless FORCE is set, and a non-owner is restricted by ENABLE
 * alone. Call this at startup so a half-finished cutover is visible in the logs
 * instead of silently assumed.
 */
export async function rlsEnforcementStatus(): Promise<{
  postgres: boolean;
  policies: number;
  enforced: boolean;
}> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) return { postgres: false, policies: 0, enforced: false };

  const rows = await prisma.$queryRaw<
    { policies: bigint; owner_bypass: boolean; forced: boolean }[]
  >`
    SELECT
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS policies,
      (SELECT bool_or(c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'Member') AS owner_bypass,
      (SELECT bool_or(c.relforcerowsecurity)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'Member') AS forced
  `;
  const policies = Number(rows[0]?.policies ?? 0);
  const ownerBypass = rows[0]?.owner_bypass ?? false;
  const forced = rows[0]?.forced ?? false;
  return { postgres: true, policies, enforced: policies > 0 && (!ownerBypass || forced) };
}
