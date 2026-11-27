# Pre-Deployment Security Audit — 2026-11-23

Scope: `coop-whatsapp` at `chore/lint-no-explicit-any` (post PR #31). Read-only white-box review of `src/`, `dashboard/`, `prisma/migrations/`, `deploy/`, `Dockerfile`, `docker-compose.yml`.
Method: static evidence only; no exploit execution. Every claim below cites the file that proves it.

Verdict: **PASS with conditions.** No Critical or High severity issue found in the reviewed surface. All findings below were fixed on 2026-11-23; the remaining conditions are the deployment gates in section 4.

> **Remediation status (2026-11-23):** MEDIUM-1, MEDIUM-2 and LOW-1/LOW-3 are fixed in this branch. LOW-2 (CDN) is accepted: the only third-party script already carries a SHA-384 SRI hash and `crossorigin="anonymous"`. Regression guards live in `tests/pre-deploy-hardening.test.ts` (boot-migration revokes, append-only audit tables, CSP report endpoint).

---

## 1. Passing controls (evidence)

| # | Control | Result | Evidence |
|---|---------|--------|----------|
| 1 | SQL injection | Pass | No `queryRawUnsafe`/`executeRawUnsafe` in `src/` except `src/scripts/db-reset.ts:54` (hardcoded table list). All other raw SQL is parameterized tagged templates (`src/lib/tenant-context.ts`, `src/services/audit.ts:58`). |
| 2 | XSS | Pass | CSP has no `'unsafe-inline'` for scripts and `scriptSrcAttr: 'none'` (`src/app.ts:114-129`); `frameAncestors: 'none'`. Dashboard builds HTML through `esc()` in `dashboard/app.js`. |
| 3 | CSRF | Pass | Auth cookie is `HttpOnly; SameSite=Strict; Secure` in production (`src/routes/admin.ts:96-101`). Mutating requests to `/api/admin` and `/api/developer` with a foreign `Origin` are refused (`src/app.ts:166-178`). |
| 4 | Session handling | Pass | Signed short-TTL token, revocation check, and a live DB re-check that the caller is still an active admin (`src/routes/exports.ts:34-48`). Cookie is not readable by JS. |
| 5 | Credential hashing | Pass | PIN and OTP use `scrypt` with a per-record random salt and `timingSafeEqual` (`src/lib/security.ts:5-31`). SHA-256 is used only for high-entropy opaque tokens (`src/lib/admin-auth.ts:81,99`). |
| 6 | MFA | Pass | TOTP enforced for privileged roles, with forced setup and re-verification on sensitive actions (`src/routes/developer.ts:418,588-602,661,718`). |
| 7 | Brute force | Pass | Global 120/min rate limit (`src/app.ts:189-195`), per-account 5 failures/15 min and per-IP 30/15 min with exponential lockup to 8 h (`src/lib/login-lockout.ts:5-12`), OTP single-use 10-min TTL / 5 attempts (`src/lib/phone-otp.ts:14,94`). |
| 8 | Webhook authenticity | Pass | HMAC over the raw body, constant-time compare, fail-closed in production (`src/routes/webhook.ts:32-48`; `src/services/payments/{paystack,monnify,flutterwave}.ts`; helper `src/services/payments/index.ts:250`). Deduplicated INSERT-first in `WebhookEvent` (`src/services/webhooks.ts:108-142`). |
| 9 | Tenant isolation | Pass | RLS policies in 19 migration sets (`prisma/migrations/*_rls*`); app runs as non-owner `coop_app` (`docker-compose.yml:14-18`); boot refuses to start when RLS is not enforced (`src/index.ts:126-134`). |
| 10 | Secret hygiene | Pass | No key material in the repo (`git grep` for live-key patterns + `tests/secrets-scan.test.ts`); placeholder/weak `SESSION_SECRET` and `ADMIN_JWT_SECRET` are fatal in production (`src/lib/envcheck.ts:74-97`); compose fails fast on unset infra secrets (`docker-compose.yml:12-25`). |
| 11 | Transport security | Pass | Caddy terminates TLS with automatic certificates (`deploy/Caddyfile:29`); HSTS 1 y preload (`src/app.ts:133-137`); plain-HTTP rejected at app layer using proxy-aware `req.protocol` (`src/app.ts:145-153`). |
| 12 | SSRF | Pass | Outbound probes target fixed provider hosts; Monnify base URL is allow-listed by protocol + exact hostname (`src/routes/developer.ts:1977-1996`); `redirect: "error"` and 6 s timeout (`src/routes/developer.ts:216-224`). |
| 13 | File handling / traversal | Pass | No multipart parser; CSV/Excel extension allow-list (`src/routes/admin.ts:1759-1763`); export download validates a strict filename regex, the cooperative prefix, and applies `basename()` (`src/routes/exports.ts:52-72`). |
| 14 | Log hygiene | Pass | Structured JSON logger redacts keys ending in phone/pin/token/secret/password/authorization/bvn/nin/account/otp/totp (`src/lib/logger.ts:18-37`). 5xx responses are generic (`src/app.ts:57-70`). |
| 15 | Dependencies | Pass | `npm audit --omit=dev` → 0 vulnerabilities (info/low/moderate/high/critical all 0). |
| 16 | Crash / shutdown safety | Pass | `uncaughtException` and `unhandledRejection` exit non-zero through graceful shutdown (`src/index.ts:65-76`); `forceCloseConnections` (`src/app.ts:63`). |
| 17 | Source disclosure | Pass | `sourceMap: false` in `tsconfig.json`; `dist/` ships no maps. |
| 18 | Network exposure | Pass | Only Caddy publishes ports 80/443 (`docker-compose.yml:105-108`); app, Postgres and Redis are internal; Redis is password-protected; container runs as `USER coop` (`Dockerfile:55`) with a healthcheck. |
| 19 | Proxy trust | Pass | Default `trustProxy` is `loopback, linklocal, uniquelocal` — forged `X-Forwarded-*` from the internet is not trusted (`src/lib/trust-proxy.ts:31`). |
| 20 | Login forensics | Pass | Every login outcome, including locks, is appended to `LoginAttempt` (`src/lib/login-lockout.ts:39-49`). |

---

## 2. Residual risk (not a defect, but decide before launch)

1. **Third-party script origin — accepted.** CSP allows `https://cdn.jsdelivr.net` (`src/app.ts:121-124`), and the single script loaded from it (`chart.js` in `dashboard/index.html:10`) carries `integrity="sha384-…"` and `crossorigin="anonymous"`, so a CDN compromise cannot swap the payload silently. Self-hosting remains a nice-to-have.
2. **`web/` SPA — removed.** The built `web/dist` existed and `web/src/App.tsx` stored an auth token in `localStorage`. It was never served (the only static root is `dashboard/`, `src/app.ts:290-292`), so it was deleted along with its `.gitignore` entries rather than left as a footgun.
3. **Untested money paths.** This pass verified webhook *authenticity*, not business invariants (amount vs. expected, double-credit under concurrent replay, payout approval chain). Those need staging tests with real provider payloads.
4. **Dependabot backlog.** 12 PRs open since 2026-10-17, including majors: Prisma 6→7, pino 9→10, tesseract.js 5→7, pdf-parse 1→2. None are known-vulnerable, but the longer they sit the riskier the upgrade.

---

## 3. Findings (all fixed)

### MEDIUM-1 — `coop_app` could UPDATE/DELETE the audit trail — **FIXED**
`deploy/bootstrap.sh` granted `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` to the runtime role, which includes `AuditLog`, `LoginAttempt` and `WebhookEvent`. RLS stopped cross-tenant access, but an application-layer compromise could rewrite or erase its own tenant's audit history.

Fix: `scripts/db-migrate.mjs` revokes `UPDATE, DELETE` on `AuditLog` and `LoginAttempt`, and `DELETE` on `WebhookEvent` (retry/DLQ still needs `UPDATE`), as the owner, after every `migrate deploy`. `deploy/bootstrap.sh` applies the same idempotent revokes after its grants (guarded by `to_regclass`, since a fresh database has no tables yet). `tests/pre-deploy-hardening.test.ts` fails if the revokes disappear or if source code starts mutating those models.

### MEDIUM-2 — Backups fell back to plaintext — **FIXED**
`deploy/backup.sh` refused plaintext only when `NODE_ENV=production` or `REQUIRE_ENCRYPTED_BACKUPS=1` was set — and the cron job runs without `NODE_ENV`, so a missing key silently produced an unencrypted dump.

Fix: a missing `BACKUP_ENCRYPTION_KEY` is now fatal unless the operator sets `BACKUP_ALLOW_PLAINTEXT=1` explicitly; `deploy/.env.example` documents the opt-out as throwaway-only.

### LOW-1 — Dead `localStorage` token client — **FIXED** (see 2.2)

### LOW-2 — CDN dependency in CSP — **ACCEPTED** (SRI pinned, see 2.1)

### LOW-3 — No CSP violation reporting — **FIXED**
Added `reportUri: ["/api/csp-report"]` to the Helmet CSP and a `POST /api/csp-report` collector in `src/app.ts`. It accepts both the legacy `application/csp-report` shape and the Reporting API batch (`application/reports+json`), logs only truncated `directive`/`blocked`/`document` fields at debug level, and always returns 204.

---

## 4. Deployment gates

Must pass before `docker compose up -d`:

1. `WHATSAPP_APP_SECRET` set (production rejects unsigned webhooks — `src/routes/webhook.ts:35`).
2. `DATABASE_URL` uses the non-owner `coop_app` role and `DATABASE_OWNER_URL` the owner role, or boot aborts (`src/index.ts:126-134`).
3. `SESSION_SECRET` and `ADMIN_JWT_SECRET` are 32+ random chars, not placeholders (`src/lib/envcheck.ts:74-97`).
4. `DOMAIN` is a real hostname whose A record points at the VM, or Caddy serves a self-signed localhost cert.
5. `BACKUP_ENCRYPTION_KEY` set (bootstrap generates it; the backup job now refuses to run without it).
6. Confirm the boot log says `revoked …` for `AuditLog`, `LoginAttempt` and `WebhookEvent` at first start.

## 5. What this audit did not cover

- Runtime/DAST testing, fuzzing, or dependency-confusion checks.
- Provider-side configuration (Meta app permissions, Paystack/Monnify dashboard settings, webhook URL allow-lists).
- Business-logic invariants for loans, savings, dividends and payouts.
- OS hardening of the Oracle VM beyond the bootstrap script.
