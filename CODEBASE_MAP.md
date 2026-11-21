# CODEBASE_MAP.md — one-page map of coop-whatsapp

Read this before planning any major change. Update it in the same PR whenever
entry points, folders, storage or sensitive boundaries move. Full details live in
`README.md`; rules live in `RULES.md`.

## Runtime shape

```
WhatsApp / Telegram ─┐
Payment webhooks ────┼─▶ Fastify (src/app.ts) ─▶ src/routes/* ─▶ src/services/* ─▶ Prisma ─▶ PostgreSQL
Dashboard SPA ───────┘            │                                  │
                                  ├─ src/lib/* (auth, cache, audit ctx)  └─ Redis (cache, rate limits, BullMQ)
                                  └─ /dashboard (static) + web/ (Vite SPA)
```

- Process entry: `src/index.ts`; app assembly/hooks/errors: `src/app.ts`;
  config: `src/config.ts`; startup env validation: `src/lib/envcheck.ts`.
- Scheduler + queue workers: `src/services/scheduler.ts`, `src/lib/queue.ts`
  (started from `index.ts`).

## Where things live

| Concern                                 | Location                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| HTTP routes (coop)                      | `src/routes/admin.ts`                                                                                    |
| HTTP routes (platform console, ops API) | `src/routes/developer.ts`                                                                                |
| WhatsApp webhook + verification         | `src/routes/webhook.ts`, `src/lib/inbound*.ts`                                                           |
| Payment/webhook adapters                | `src/routes/payments.ts`, `src/services/payments/*`                                                      |
| Exports (CSV/XLSX/PDF)                  | `src/routes/exports.ts`, `src/services/exports.ts`                                                       |
| Reconciler | `src/services/reconcile.ts`, `reconciliation.ts`, `provider-balances.ts` |
| Input surface | `src/lib/pick.ts` (deny-list) plus per-route field reads |
| Business logic                          | `src/services/*` — money, loans, savings, withdrawals, KYC, roles                                        |
| Audit trail                             | `src/services/audit.ts` (hash-chained, per coop), `src/services/platform-audit.ts`                       |
| Auth                                    | `src/lib/admin-auth.ts`, `src/lib/platform-auth.ts`, `src/lib/magic-link.ts`, `src/lib/login-lockout.ts`, `src/lib/phone-otp.ts`,
`src/lib/disposable-emails.ts` |
| Request context (IP/UA/requestId)       | `src/lib/request-context.ts`                                                                             |
| Alerts & anomaly rules                  | `src/lib/alerting.ts`, `src/lib/anomaly-rules.ts`, `src/lib/login-anomaly.ts`                            |
| Cache / rate limits / claims            | `src/lib/cache.ts` (Redis + in-memory fallback)                                                          |
| Dashboards                              | `dashboard/` (static, served at `/dashboard/`), `web/` (Vite SPA)                                        |
| Tests                                   | `tests/*.test.ts`, helpers in `tests/setup.ts`, config `vitest.config.ts`                                |
| Ops scripts                             | `scripts/` (`smoke.mjs`, `production-preflight.mjs`, `db-migrate.mjs`, `prisma-generate.mjs`)            |

## Data, persistence, migrations

- Prisma models: `prisma/schema.prisma` (PostgreSQL, production).
- Test schema: `prisma/schema.local.prisma` (SQLite at `prisma/dev.db`); the two
  must stay identical — enforced by `tests/schema-sync.test.ts`.
- Migrations: `prisma/migrations/<timestamp>_<name>/migration.sql`. Production
  applies them with `npm run db:migrate:deploy`; local tests use
  `npx prisma db push --schema prisma/schema.local.prisma --skip-generate`.
- Prisma client is generated per target: `node scripts/prisma-generate.mjs --local`
  for tests, `--prod` for deployment. Never run vitest after a `--prod` generate.
- Postgres-specific RLS resolvers (e.g. `app.resolve_coop_by_email`) live in
  migrations and are used through `src/lib/tenant-context.ts`; SQLite has a
  direct-query fallback.
- Persistent artifacts outside the DB: `backups/`, `exports/`, `prisma/dev.db`
  (all gitignored), backups handled by `src/services/backup.ts`.

## Sensitive / off-limits

- `.env`, `.env.docker`, `platform-owner-pin.txt`, `backups/`, `exports/`,
  `prisma/dev.db*`, `cookies.txt` — secrets or personal data; never read into
  context, print, commit, or paste into tickets.
- `src/services/audit.ts` hash chain, `LoginAttempt` ledger, `LoginLock` state,
  `PhoneOtp` hashes,
  and migration SQL are integrity-critical: no deletes, no rewrites, no
  "fix-unused" migrations.
- `src/lib/*auth*`, `src/routes/admin.ts`, `src/routes/developer.ts` — auth and
  authorization boundaries; changes need security review + tests.
- `deploy/` (Caddyfile, env templates), `Dockerfile`, `docker-compose.yml`,
  `render.yaml`, `.github/workflows/ci.yml` — change only with deployment impact
  in mind; Caddy strips identifying headers and rejects dotfiles.
- `dashboard/` and `web/` are browser code: no secrets, and keep CSP-compatible
  patterns (no inline event handlers in new files).

## Fast orientation

- Trace a money flow: `routes/admin.ts` → `services/withdrawals.ts` (or
  `payments/*`) → `audit()` → provider adapter.
- Trace a login: `routes/admin.ts` (`/login`, `/magic-link/*`) →
  `lib/login-lockout.ts` → `lib/magic-link.ts` → `lib/cache.ts`.
- Trace a webhook: `routes/webhook.ts` / `routes/payments.ts` →
  `lib/inbound-dedupe.ts` → `services/*` → `lib/webhook-dlq.ts` on failure.
- Verification: `npm run check` (see `RULES.md` §6).
