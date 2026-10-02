# Row-Level Security — activation plan (DRAFT)

`recommended_policies.sql` is a **draft**, kept out of `prisma/migrations/` on
purpose. It is **not** run by `prisma migrate deploy`, so it cannot break the
production boot path.

## Why not apply it yet

`FORCE ROW LEVEL SECURITY` + a `current_setting('app.current_cooperative_id')`
policy means **every** query against a tenant table returns zero rows unless the
connection's transaction first sets that GUC. Today only the dashboard admin API
sets it (`routes/admin.ts`), on a single pooled connection. The chat bot, the
money services, the schedulers and the webhook processors do **not** wrap their
queries in that context — so flipping this on today would silently blank the
entire app.

## Activation sequence (each step is a separate, revertible change)

1. **Centralize a tenant query helper.** Add a `withCoopContext(cooperativeId, fn)`
   that opens `prisma.$transaction` and issues
   `SELECT set_config('app.current_cooperative_id', $coop, true)` as its first
   statement. Route every service/scheduler/webhook read+write through it.
2. **Apply the migration** by copying `recommended_policies.sql` into a new
   `prisma/migrations/<timestamp>_rls/migration.sql` and running
   `npm run prisma:generate && node scripts/db-migrate.mjs` against staging
   Postgres (not SQLite — this is Postgres-only).
3. **Enable the tests** by setting `RLS_ENABLED=1` with a Postgres `DATABASE_URL`
   in CI; `tests/rls-isolation.test.ts` stops skipping.
4. **Audit fail-closed behavior** with the "no context" test (last case in the
   RLS suite) to confirm cross-tenant reads return zero rows.

## Notes / pitfalls

- `set_config(..., false)` is session-scoped and leaks across pooled
  connections; always wrap it in a transaction and reset/relinquish via
  `set_config('app.current_cooperative_id', '', true)` (or rely on the
  transaction ending) — see `routes/admin.ts` for the existing pattern.
- `Posting`, `DividendEntry` and `DeductionItem` have **no** `cooperativeId`;
  their policy reaches through the parent (`JournalEntry` / `Dividend` /
  `DeductionBatch`). Budget for slower reads on those joins.
- The GUC fallback is an empty string (deny-all), so an unset context is
  fail-closed by construction — the property the last RLS test asserts.