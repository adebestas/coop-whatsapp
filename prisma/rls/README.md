# Row-Level Security — activation plan

## Where things stand

| Stage | Artifact | State |
| --- | --- | --- |
| 1 — ENABLE | `prisma/migrations/20261005000000_rls_policies/migration.sql` | **Applied.** ENABLE without FORCE, so the table owner (the app's current `DATABASE_URL`) bypasses RLS — zero behaviour change. |
| 2 — FORCE | `prisma/rls/recommended_policies.sql` | **Draft, not applied.** Adds FORCE, which removes the owner bypass. Do not apply until every tenant query sets the GUC. |

`app.current_coop_id()` returns NULL when the GUC is unset, so every comparison
is NULL and every tenant query returns zero rows — fail-closed by construction.

## Why Stage 1 is safe to deploy

`ENABLE` (without `FORCE`) only restricts **non-owner** roles. The app connects
as the table owner, so it bypasses the policies entirely. Verified on a fresh
Postgres 16:

- owner, no GUC → sees all rows (bypass)
- non-owner, no GUC → 0 rows (fail-closed)
- non-owner, GUC = coop A → only coop A's rows

## Why Stage 2 is not applied yet

`FORCE` removes the owner bypass, so **every** query against a tenant table
returns zero rows unless the connection's transaction first sets
`app.current_cooperative_id`. Today only the dashboard admin API sets it
(`routes/admin.ts`), on a single pooled connection. The chat bot, the money
services, the schedulers and the webhook processors do **not** wrap their
queries in that context — flipping FORCE on today would silently blank the app.

## Activation sequence (each step is a separate, revertible change)

1. **Centralize a tenant query helper.** ✅ DONE — `src/lib/tenant-context.ts`
   exposes `withCoopContext(cooperativeId, fn)` and `setCoopContext(tx, coopId)`
   (transaction-local `set_config(..., true)`, no-op on SQLite). The dividend
   engine already runs its write transaction through `setCoopContext`
   (`src/services/dividends.ts`). Remaining: route the other service/scheduler/
   webhook read+write paths through it.
2. **Apply the Stage 1 migration.** ✅ DONE — `prisma/migrations/20261005000000_rls_policies/`.
   Postgres-only; a no-op on SQLite (local dev + `npm test`).
3. **Route every tenant query through the helper** (in progress). Until this is
   complete, the app must keep connecting as the table owner.
4. **Apply Stage 2 (FORCE)** by copying `recommended_policies.sql` into a new
   `prisma/migrations/<timestamp>_rls_force/migration.sql`, and point the app at
   a **non-owner** role so enforcement actually bites.
5. **Enable the tests** by setting `RLS_ENABLED=1` with a Postgres `DATABASE_URL`
   in CI; `tests/rls-isolation.test.ts` stops skipping.
6. **Audit fail-closed behavior** with the "no context" test (last case in the
   RLS suite) to confirm cross-tenant reads return zero rows.

## Notes / pitfalls

- `set_config(..., false)` is session-scoped and leaks across pooled
  connections; always wrap it in a transaction and use
  `set_config(..., true)` (transaction-local) — see `src/lib/tenant-context.ts`.
  The existing `routes/admin.ts` call uses `false` and should be migrated to the
  helper.
- `Posting`, `DividendEntry`, `DeductionItem`, `Guarantor`, `LoanRepayment`,
  `VoteBallot`, `VoteCandidate`, `PollBallot`, `PollOption`, `DeathValidation`,
  `FavoritePayee`, `MemberProgress` and `Wallet` have **no** `cooperativeId`;
  their policy reaches through the parent. Budget for slower reads on those
  joins.
- The `app` schema must exist before `CREATE FUNCTION app.current_coop_id()`;
  the migration creates it with `CREATE SCHEMA IF NOT EXISTS app`.
- `WebhookEvent` has no `cooperativeId` and is intentionally **not** covered.
