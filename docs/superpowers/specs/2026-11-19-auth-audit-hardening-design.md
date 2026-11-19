# Auth, audit and edge hardening â€” design

Status: awaiting review. No code written.

Scope approved by owner on 2026-11-19: all six phases, in order. Magic links target
dashboard admins and developer/owner accounts only. Anomaly alerts go to the Telegram
ops chat (`OPS_ALERT_TELEGRAM_CHAT_ID`) and the error webhook (`ERROR_WEBHOOK_URL`)
through the existing `alertDevelopers()` helper.

## Non-goals

- Magic links for members (they authenticate through WhatsApp/Telegram identity; most
  have no email address).
- Replacing WhatsApp/PIN login. Dashboard login stays phone + PIN, optionally plus TOTP.
- Purging git history. `.env` was never committed; this work is prevention + detection.
- Deleting unverified NIN data (explicitly deferred by the owner).
- New payment providers. `PAYMENT_PROVIDER` stays unused; provider adapters are
  selected by adapter presence, not env.

## Existing foundations we must not duplicate

| Concern | Already present |
| --- | --- |
| ORM | Prisma, PG in prod, SQLite for tests, `prisma/migrations/*`, RLS job in CI |
| Login throttling | `checkLoginRateLimit` â€” 5/min IP, 10/15 min account (`src/routes/admin.ts:32`) |
| TOTP | enrolment via chat, replay claim via `claimOnce` (`admin.ts:193`) |
| Audit | hash-chained `AuditLog` per cooperative; `PlatformAuditLog` for dashboard operators |
| Alerts | `alertSupers`, `alertAdmin`, `alertDevelopers` (`src/lib/alerting.ts`) |
| Edge | Caddy reverse proxy, `deploy/Caddyfile` |
| Reconciliation | `runReconcileJob` + repeatable `reconcile` job, 24 h rolling |
| Preflight | `npm run preflight`, now wired into the CI `postgres-migrations` job |

## Phase 1 â€” Login lockout, generic error IDs, magic links

### 1.1 Persistent lockout

Redis counters reset on restart and `resetRateLimit` erases evidence on success, so a
slow attacker (2 attempts/hour) is never locked. Add a durable ledger:

```
model LoginAttempt {
  id           String   @id @default(cuid())
  surface      String   // dashboard_admin | dashboard_developer
  phone        String?  // attempted identifier (never empty)
  ip           String
  outcome      String   // success | bad_credentials | totp_failed | totp_reused |
                        // locked | inactive | magic_link_used | magic_link_expired
  errorId      String?
  createdAt    DateTime @default(now())
  @@index([surface, phone, createdAt])
  @@index([surface, ip, createdAt])
}
```

Lockout policy (computed from `LoginAttempt`, evaluated before credential check):

- 10 failures / 15 min for one account â†’ lock 30 min.
- Each further lock within 24 h doubles the duration, cap 24 h.
- 30 failures / 15 min from one IP â†’ IP lock 1 h (affects both surfaces).
- Stored on `Member.pinLockedUntil`? **No** â€” that field is shared with chat PIN
  entry, and locking a member out of WhatsApp because of a dashboard attack is a
  self-inflicted outage. Lock state is derived from the ledger; a short-lived Redis
  key (`lock:<surface>:<phone>`) carries the hot path.
- Unlock: automatic expiry, or a superadmin action `POST /api/admin/unlock` which
  writes an audit entry and an ops alert.

### 1.2 Generic errors with request IDs

The app already returns `{ error: "Something went wrong. Please try again.", requestId }`
for 5xx and logs the full error (`src/app.ts`). Reuse that id; do not add a new format.

- Login/auth failures return `{ error: <generic text>, requestId }` for 401, 403, 429
  and locked responses. Never reveal whether the phone exists, is locked, or the PIN
  was wrong.
- `req.log.error({ err, requestId, route, ip, actorId })` carries the full detail; the
  client only ever sees the opaque id.
- No provider payloads, SQL, or phone numbers in the response body.

Verification-response timing stays constant: keep the existing dummy-hash pattern and
extend it to the lockout path (locked accounts still pay one scrypt verification).

### 1.3 Magic link login

```
model MagicLinkToken {
  id             String    @id @default(cuid())
  memberId       String
  member         Member    @relation(fields: [memberId], references: [id], onDelete: Cascade)
  cooperativeId  String
  tokenHash      String    @unique   // sha256(token); plaintext never stored or logged
  purpose        String    @default("dashboard_login")
  requestedIp    String
  requestUaHash  String?             // sha256 of UA, for anomaly scoring only
  expiresAt      DateTime            // requestedAt + 15 min
  usedAt         DateTime?
  usedIp         String?
  revokedAt      DateTime?
  createdAt      DateTime  @default(now())
  @@index([memberId, createdAt])
  @@index([expiresAt])
}
```

Token: 32 random bytes, base64url. Only the SHA-256 digest is persisted; the plaintext
exists once, in the email body.

Flow:

1. `POST /api/admin/magic-link/request { email }` (and `/api/developer/magic-link/request`).
   - Look up an admin/superadmin (or owner/developer) by verified email.
   - Always return 202 `{ ok: true, errorId }` â€” identical response whether the account
     exists, is locked, has no email, or email delivery fails. Error details go to logs
     under the `errorId`.
   - On success: revoke (not delete) any unused tokens for that member, create a new one,
     send `{PUBLIC_BASE_URL}/login/magic?t=<token>` with a 15-minute notice via the
     existing SMTP sender for statements.
2. `GET /login/magic?t=` â€” a static dashboard page that POSTs the token.
3. `POST /api/admin/magic-link/consume { token }`.
   - Single-use: `updateMany({ where: { tokenHash, usedAt: null, revokedAt: null,
     expiresAt: { gt: now } }, data: { usedAt: now, usedIp: ip } })`. `count === 0` â†’
     generic 401 + `errorId`; the token is dead after the first attempt regardless of
     outcome (claim-then-validate, never validate-then-claim).
   - Bind: token only mints a session for the member it was issued to; role and status
     are re-checked live (suspended/deceased â†’ inert).
   - TOTP: if the account has `totpSecret`, consumption requires `totp` in the same
     request; no session without it.
   - Success: `sign()` + `setAuthCookie()` â€” identical cookie path as PIN login â€” and
     audit `auth.magic_link.consume`.
4. Session revocation: `revokeToken()` on the current session is already supported;
   password/PIN change additionally revokes all `MagicLinkToken`s and bumps a
   per-member `sessionEpoch` (see Phase 2) so older cookies die.

Rate limits: 3 requests / 15 min per account and 10 / hour per IP; both recorded in
`LoginAttempt` (`outcome = magic_link_requested`).

## Phase 2 â€” Audit coverage and anomaly alerts

### 2.1 Schema

- `AuditLog` and `PlatformAuditLog` gain `ip String?`, `userAgent String?`,
  `errorId String?`.
- New `SecurityEvent` is **not** created: `LoginAttempt` covers auth, and the hash
  chains must stay the single source of truth for money and admin actions.

### 2.2 Mandatory event taxonomy

| Action | Where |
| --- | --- |
| `auth.login.success` / `.failed` / `.locked` / `.unlocked` | admin + developer routes |
| `auth.magic_link.request` / `.consume` / `.rejected` | new routes |
| `auth.pin.change` / `auth.password.change` / `auth.totp.change` | chat + dashboard |
| `admin.member.update`, `admin.wallet.adjust`, `admin.wallet.freeze` | admin services |
| `money.*` (existing) | unchanged, but gain actor IP from the request context |
| `role.set` | already audited; add IP |

Every entry records who (memberId/phone/role), what (action/target), where (IP, UA),
when (server timestamp). A request-scoped `AsyncLocalStorage` context (same pattern as
`tenant-context`) supplies IP/UA so service-level `audit()` calls do not need plumbing.

### 2.3 Anomaly rules (evaluated on write, alert through `alertDevelopers`)

- `auth.login.lockout_triggered` â€” always alert.
- â‰¥3 accounts locked from one IP in 10 min.
- Successful login from an IP never seen for that member in 90 days.
- Admin/owner login outside 06:00â€“22:00 Africa/Lagos.
- `admin.wallet.adjust` or `role.set` outside business hours, or above
  `ALERT_WALLET_THRESHOLD_KOBO`.
- PIN/password change followed by a payout within 30 min.
- Magic-link token replay (`usedAt` already set) â€” always alert.
- Thresholds live in one `src/services/anomaly-rules.ts` with unit tests; each alert is
  deduplicated with `claimOnce` (1 h window) so a burst is one Telegram message.

## Phase 3 â€” Edge and repository hardening

- `deploy/Caddyfile`:
  - `@dotfiles path /.* /.env* /.git* /.htaccess /.htpasswd /credentials* /.*`
  - `respond @dotfiles 404`
  - `header -Server -X-Powered-By` (and remove `Server` from error pages via
    `header_down`).
  - HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`; CSP kept
    conservative because the dashboard is served from the same origin.
- Fastify: `onSend` hook deletes `x-powered-by` and `server` if any plugin adds them;
  `disableRequestLogging` untouched.
- `.env.example` regenerated from the `envcheck.ts` registry plus the 36 currently
  undocumented keys; the 5 never-read keys (`PAYMENT_PROVIDER`, `VTU_PROVIDER`,
  `FLUTTERWAVE_PUBLIC_KEY`, `PAYSTACK_PREFERRED_BANK`, `PAYSTACK_TRANSFER_SOURCE`)
  are removed with a CHANGELOG note.
- Tests: a vitest case that builds the app and asserts no `x-powered-by`/`server`
  header; a repo test asserting `.env` is ignored and no `.env*` file except
  `.env.example`, `deploy/.env.example` and `docker-compose` templates is tracked.

## Phase 4 â€” Identity quality

- Disposable email: `src/lib/disposable-emails.ts`, a curated static domain list plus
  `DISPOSABLE_EMAIL_DOMAINS` (comma separated) merged at boot. Applied wherever an
  email is accepted (member email capture, magic-link request, admin creation).
  Rejection message is deliberately vague ("use a different email address").
- Phone verification for dashboard accounts: admins/developers whose `phoneVerified`
  is false must confirm a 6-digit OTP sent over the existing WhatsApp/Telegram channel
  before a magic link is issued; OTPs are hashed, 10-minute TTL, 5 attempts, single
  use. Members are unaffected (their channel identity is already the verified phone).

## Phase 5 â€” Input-surface audit (mass assignment)

- Enumerate every `prisma.*.create/update` whose `data` derives from `req.body`.
- Replace loose spreads with an explicit allow-list per endpoint via a shared
  `pickAllowed(body, fields)` helper.
- Deny-list enforced project-wide: `id`, `role`, `isAdmin`, `plan`, `cooperativeId`,
  `status`, `balance`, `pin`, `totpSecret` can never arrive from a request body.
- Regression test posts each privileged field to every mutating dashboard endpoint and
  asserts the stored record is unchanged (`tests/mass-assignment.test.ts`).
- Report of endpoints inspected is committed to `docs/security/input-surface.md`.

## Phase 6 â€” Agent artifacts and reconciliation

- `AGENTS.md` at repo root: stack, commands, folder map, forbidden actions (no prod
  writes, no data deletion, no secrets in code, no schema edits without sync), and the
  instruction to read `CODEBASE_MAP.md` before planning.
- `CODEBASE_MAP.md`: one page â€” request entry points, services, Prisma models, jobs,
  dashboards, deploy scripts, "do not touch" zones.
- `npm run check`: typecheck â†’ lint â†’ format:check (widened to tests/scripts) â†’
  vitest â†’ `npm audit --omit=dev`; CI runs it verbatim; a task is not "done" without
  pasted output.
- Reconciliation extension: `runReconcileJob` additionally fetches provider balances
  (Monnify/Paystack/Flutterwave) when keys exist, compares to the `assets:bank` journal
  balance, writes `ReconciliationLog` with `source = "provider"`, and alerts via
  `alertDevelopers` on drift above `RECONCILE_DRIFT_THRESHOLD_KOBO` (default â‚¦1).
  The job name and 24 h cadence stay unchanged; the env var makes the tick configurable.

## Testing and rollout per phase

1. Migration in both Prisma schemas + hand-written SQL (SQLite applied with
   `prisma db push --schema prisma/schema.local.prisma`).
2. Unit/integration vitest for the phase; PG migration + RLS job must stay green.
3. `npx tsc --noEmit`, `eslint`, `prettier --check`, targeted `vitest`.
4. No phase ships without an audit event and (where applicable) an anomaly rule.
5. Each phase is its own commit; PR #27 stays the integration branch unless told
   otherwise.

## Approved decisions (2026-11-19)

- Lockout: 5 failures / 15 min -> 15 min, doubling, cap 8 h (owner choice).
- Magic link: additional login method; dashboard phone+PIN stays; TOTP still required when enrolled.
- Error IDs: reuse the Fastify request id (`requestId`) already returned by `setErrorHandler`; no separate module.
- Headers: helmet already hides x-powered-by; add Caddy dotfile deny/header-strip plus a regression test.
- Email: extract the nodemailer transport out of exports.ts into src/lib/email.ts before Phase 1 routes.
- PlatformAdmin gains email + emailVerifiedAt; Member gains emailVerifiedAt; links only for verified addresses.
- Unwired cleanup approved: delete scripts/load-smoke.js, fail the smoke step on main when the base URL is unset, widen lint/format to tests+scripts, remove the 5 dead env vars, keep the DLQ endpoint API-only, document loan_reminders.

## Risks / open questions

- **Email deliverability**: magic links depend on SMTP; if SMTP is unset the request
  endpoint returns 202 and logs `errorId` â€” it will silently never work in that
  environment. Preflight should warn when SMTP is missing but magic links are enabled.
- **Shared office NAT**: IP-based lockout can lock a whole branch office. The account
  lock is the primary control; the IP lock is 1 h and skips known-good admin IPs if
  `TRUSTED_ADMIN_IPS` is set.
- **`Server` header**: Caddy does not add one by default; the Caddyfile change is
  defence-in-depth for any future proxy.
- **Session epoch**: revoking old sessions on PIN change requires a `sessionEpoch`
  column on `Member` â€” included in the Phase 2 migration.
