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
3. **Solve the RLS bootstrap.** ✅ DONE — `prisma/migrations/20261006000000_rls_resolvers/`
   adds SECURITY DEFINER functions `app.resolve_coop_by_phone(text)` and
   `app.resolve_coop_by_alt_channel(text)`. They are owned by the table owner,
   bypass RLS, and return **only** a cooperative id (NULL when unknown or
   ambiguous). App-side wrappers live in `src/lib/tenant-context.ts`
   (`resolveCoopByPhone` / `resolveCoopByAltChannel`), with a direct-query
   fallback on SQLite. This is what lets the app discover the tenant before it
   can set the GUC.
4. **Route every tenant query through the helper.** ✅ DONE — all entry points
   are wired:
   - **Chat** — `handleMessage` resolves the sender's cooperative and runs the
     whole handler inside `withCoopContext`; services keep using the global
     `prisma` proxy, which routes to the transaction. Outbound sends are
     deferred until after the transaction commits (`src/lib/deferred.ts`), so
     the transaction never spans network I/O.
   - **Admin dashboard** — all 34 authenticated routes run inside `withTenant`;
     `requireLiveAdmin` and `/api/admin/login` resolve the tenant first.
   - **Join flow** — when the sender has no cooperative yet, `handleMessage`
     resolves it from the session's pending `joinCode` and runs the flow in
     context.
   - **Webhooks** — the payment webhook resolves the cooperative from the
     virtual account number; the payout webhook from the payout reference.
   - **Schedulers** — every scheduled job iterates cooperatives and wraps each
     in `withCoopContext` (`forEachCoop`).
   - **System-level ops** (backup, backup verification) use `ownerPrisma`
     (`DATABASE_OWNER_URL`) and bypass RLS by design.
5. **Apply Stage 2 (FORCE)** — the remaining step. Runbook:
   1. Provision the non-owner role: run `prisma/rls/provision_app_role.sql` as the
      owner (replace the password placeholder with a vault secret).
   2. Copy `recommended_policies.sql` (FORCE-only — Stage 1 already created the
      policies) into `prisma/migrations/<timestamp>_rls_force/migration.sql`.
   3. Deploy with `DATABASE_URL` = `coop_app` and `DATABASE_OWNER_URL` = the owner.
      Migrations and the backup dump use the owner; the app uses `coop_app`.
   4. Confirm the startup canary logs `RLS enforced for the current role`.
   5. Roll back by dropping FORCE (`ALTER TABLE ... NO FORCE ROW LEVEL SECURITY`)
      and pointing `DATABASE_URL` back at the owner.
   Verified on Postgres 16: with FORCE applied, the isolation suite passes 12/12
   and the canary reports enforced for `coop_app`.
6. **Enable the tests.** ✅ DONE — `tests/rls-isolation.test.ts` now provisions a
   non-owner `coop_app` role, connects a second Prisma client as it, and runs
   every isolation assertion inside a transaction that sets the GUC. The CI
   `postgres-migrations` job runs it with `RLS_ENABLED=1` against a fresh
   Postgres. (The owner bypasses RLS, so a non-owner client is required — the
   previous version connected as the owner and could never pass.)
7. **Audit fail-closed behavior** with the "no context" test (last case in the
   RLS suite) to confirm cross-tenant reads return zero rows.
8. **Canary.** ✅ DONE — `rlsEnforcementStatus()` (called at startup in
   `src/index.ts`) logs whether RLS is actually enforced for the current role.
   "Policies exist" is not the same as "isolation is enforced": the table owner
   bypasses RLS unless FORCE is set. The canary makes a half-finished cutover
   visible in the logs instead of silently assumed.

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
