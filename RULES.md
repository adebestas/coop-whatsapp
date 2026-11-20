# RULES.md — engineering rules for coop-whatsapp

Read this file and `CODEBASE_MAP.md` at the start of every session, before
planning or editing. These rules override habit and convenience. If a request
conflicts with them, stop and ask.

## 1. Tech stack

- **Runtime**: Node.js (ESM), TypeScript 5.7 (`tsc --noEmit` for types), executed
  with `tsx` in dev and `node dist/index.js` in production.
- **HTTP**: Fastify 5 with `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`,
  `@fastify/compress`, `@fastify/static` (dashboard at `/dashboard/`).
- **Data**: PostgreSQL in production, SQLite (`prisma/dev.db`) in tests via
  `prisma/schema.local.prisma`. Prisma 6 is the only ORM. 121 models.
- **Cache/queues**: Redis via `ioredis`; BullMQ for jobs; in-memory fallbacks in
  `src/lib/cache.ts` so tests run without Redis.
- **Channels**: WhatsApp Cloud API (primary), Telegram long-polling (optional).
- **Money**: Monnify (primary), Paystack (fallback), Flutterwave (3rd); amounts are
  **integers in kobo** everywhere.
- **Docs/files**: `exceljs`, `pdfkit`, `pdf-parse`, `tesseract.js` (OCR), `nodemailer`.
- **Validation**: `zod` at every HTTP/LLM/tool boundary.
- **Tests**: `vitest` (`tests/*.test.ts`), real SQLite DB, no mocking of Prisma.
- **Tooling**: ESLint 10 + typescript-eslint, Prettier 3 (`printWidth` per
  `.prettierrc`), GitHub Actions in `.github/workflows/ci.yml`.

## 2. Layout and module boundaries

- `src/app.ts` builds the Fastify app (plugins, hooks, static dashboard, error
  handler). `src/index.ts` is the process entry; `src/config.ts` central config.
- `src/routes/` — HTTP surface only: `admin.ts`, `developer.ts`, `webhook.ts`,
  `payments.ts`, `exports.ts`, `certificate.ts`. Routes parse/authorize/respond.
- `src/services/` — business logic and persistence (95 files). Money movement,
  loans, savings, KYC, audit, reconciliation live here.
- `src/lib/` — cross-cutting primitives (cache, prisma client, auth, lockout,
  magic links, email, logging, alerts, metric, i18n, request context).
- `src/types/` — shared types. `src/scripts/` + `src/seed.ts` — ops/bootstrap.
- `prisma/` — `schema.prisma` (PostgreSQL, deploy) and `schema.local.prisma`
  (SQLite, tests). They must stay structurally identical (`tests/schema-sync.test.ts`).
  `prisma/migrations/` is the only way schema reaches production.
- `dashboard/` — static vanilla-JS admin/dev consoles served from `/dashboard/`.
  `web/` — Vite SPA (separate `package.json`, not built by the root `npm test`).
- `tests/` — vitest suites; `scripts/` — build/migrate/preflight/smoke helpers.
- `deploy/` — `Caddyfile`, env templates; `docker-compose.yml`, `Dockerfile`,
  `render.yaml` at the root.

Dependency direction: `routes → services → lib`, never the reverse. Services
must not import routes. Do not put SQL/Prisma writes directly in `routes/`.

## 3. Naming

- **Files**: kebab-case (`login-lockout.ts`, `webhook-dlq.ts`); tests mirror the
  subject (`tests/magic-link.test.ts`); migrations `YYYYMMDDHHMMSS_snake_name/`.
- **Functions/variables**: camelCase; booleans read as predicates (`isLocked`,
  `hasTotp`); constants and env keys SCREAMING_SNAKE_CASE.
- **Types/interfaces**: PascalCase; no `I` prefix.
- **Prisma models**: PascalCase singular (`MagicLinkToken`); fields camelCase;
  enums SCREAMING_SNAKE.
- **Database columns**: camelCase (Prisma default) — do not add `@map` snake_case
  unless the table already uses it.
- **Routes**: `/api/admin/*` (coop dashboard), `/api/developer/*` (platform
  console), `/webhook`, `/webhooks/payments`. Verbs are nouns + action:
  `/magic-link/request`, `/magic-link/consume`.
- **Audit actions**: dotted lowercase (`auth.login.success`, `admin.wallet.adjust`,
  `loan.approve`). Never invent casing variants.
- **Branches**: `fix/<topic>`, `feat/<topic>`, `chore/<topic>`; commits follow
  Conventional Commits (`feat(auth): …`, `docs(spec): …`).

## 4. Non-negotiable practices

- Money is integer kobo. Never introduce floats for amounts.
- Every state-changing service action that touches money, members, roles or
  configuration must call `audit()` (coop) or `writePlatformAudit()` (platform).
- Every new Prisma migration must exist in **both** schemas' intent and be
  committed under `prisma/migrations/`; never `db push` against production.
- Secrets come from env only. Never log PINs, tokens, BVN/NIN, account numbers,
  phone numbers (use the logger's redaction helpers).
- Validate at the boundary with `zod`; never forward `req.body` into Prisma.
- Tests are the contract: add/extend a vitest suite for every behaviour change.

## 5. Forbidden actions (hard stops)

- Never touch production or live databases, run destructive migrations, or
  `prisma migrate reset` / `db push --accept-data-loss` outside the local test DB.
- Never delete or rewrite audit rows, `LoginAttempt` history, or financial ledgers.
- Never commit `.env`, `platform-owner-pin.txt`, backups, exports, credentials,
  or any API key/secret. `.env.example` documents keys; values stay empty.
- Never bypass authentication/authorization (no "temporary" auth skips, no
  disabled CSRF/Origin checks, no `x-powered-by` reintroduction).
- Never pass raw or unvalidated request bodies (or LLM/tool output) straight into
  database writes.
- Never weaken `tests/schema-sync.test.ts`, the hash-chain verification, or the
  lockout/anomaly gates to make a test pass.
- Never force-push a shared branch or push directly to `main`.

## 6. Definition of done

`npm run check` must exit 0 and its output pasted into the hand-off summary:

1. `tsc --noEmit` (types)
2. `eslint src/`
3. `npm audit --omit=dev --audit-level=high` (dependency security)
4. `npm run test:gate` — the curated vitest gate (auth, lockout, magic links,
   audit context, edge hardening, schema sync, webhook DLQ, loans, savings,
   exports).

`npm run check:full` runs the entire vitest suite instead of the gate. It takes
well over an hour on an 8 GB machine and has historically hit SQLite
`database is locked` when runs overlap; use it before a release or when a change
touches an area outside the gate, and never run two suites at once. Update
`CODEBASE_MAP.md` in the same change when folder structure, entry points or
sensitive areas change.
