# Platform Console (Developer Dashboard) — Design

- Status: approved for implementation (brainstorming complete)
- Date: 2026-10-17
- Author: platform owner + agent
- Related: `docs/NIGERIA-COOPERATIVE-COMPLIANCE.md` (standards/compliance briefing)

## 1. Context

coop-whatsapp is a strictly multi-tenant WhatsApp cooperative platform. Every admin token
is bound to a single `cooperativeId` and every admin route re-checks a per-coop
`Member(role ∈ admin|superadmin)` against RLS. Cooperatives are created only via the chat
`onboard` flow or seed scripts; there is **no platform-owner identity or console**.

This design adds a **platform owner ("developer") role and console** that can create
cooperatives, add admins/super-admins, set platform-wide rules with per-coop overrides, and
monitor and operate every cooperative — without weakening tenant isolation.

## 2. Goals

- A platform owner can **log in** to a separate console and **create cooperatives** and
  **add/promote admins & super-admins**.
- The owner can **set rules** — including **loan interest rate** and **loan duration
  (max repayment period)** — as platform defaults with optional bounds, which cooperatives
  may override only within bounds; the owner can **lock** a rule.
- The owner can **see what is happening per cooperative** (health + activity + alerts) and
  take **essential, audited controls** (suspend/reactivate a coop, revoke its admin sessions).
- Standards/compliance hardening: fix the AML CTR-vs-STR bug and add statutory rules.

## 3. Non-goals (YAGNI)

- No standalone microservice, no new Postgres role that bypasses RLS.
- No public/investment products (SEC-boundary risk) and no consumer lending to non-members
  (FCCPC DEON-boundary) — out of scope.
- No change to RLS Stage-2 (FORCE) in this spec.
- No self-service "developer sign-up" — owners are seeded and add other platform admins.

## 4. Scope

**Phase 1 — Platform Console**
1. `PlatformAdmin` identity + platform-scoped auth (`/api/developer/login`, 2FA).
2. Typed **rule registry** + **`PlatformPolicy`** layer (defaults, bounds, lock) with an
   effective-config resolver. Fixes the current no-range-validation gap.
3. Cooperative **provisioning** (create coop + first super-admin) and **admin management**
   (add/promote admin or super-admin by phone).
4. **Monitoring**: platform overview + per-coop health, activity feed, alerts, plus
   suspend/reactivate and revoke-sessions controls (audited).
5. Console **UI** as static pages in `dashboard/dev/`.

**Phase 2 — Standards/compliance hardening**
6. AML correction: **CTR** (≥₦5M individual / ≥₦10M corporate / $10k cross-border) vs
   **STR (no threshold)**, with configurable thresholds and SCUML status tracking.
7. Statutory rules: **reserve fund ≥25%**, education fund ≤10%, dividend cap ≤5% p.a.,
   **max loan per member**, **max repayment period**, minimum membership period.
8. Compliance metadata per coop: state, registration number/CVN, TIN, SCUML status, DPO.
9. Regulator-reporting alignment to the corrected report types.

## 5. Architecture

Reuse-first. New code sits alongside the existing admin auth and services; no new runtime.

```
dashboard/dev/  (static console: login + overview + coop detail + policies + admins)
      |
      v  fetch  /api/developer/*   (cookie coop_dev_token, X-Requested-With)
src/routes/developer.ts  ----->  src/lib/platform-auth.ts   (scope:"platform" token)
      |                          src/services/platform-policy.ts (registry + resolution)
      |                          src/services/platform-admin.ts  (admins)
      |                          src/services/platform-coops.ts  (provision, monitor, controls)
      v
src/services/coop-config.ts (getCoopConfig -> applies PlatformPolicy layer)
src/services/cooperative-provisioning.ts (provisionCooperative, extracted from onboarding)
      v
prisma (PlatformAdmin, PlatformPolicy; Cooperative.tokensValidAfter; AuditLog actor fields)
```

### 5.1 Identity & auth

- New table **`PlatformAdmin`** (`id, name, phone @unique, role ∈ owner|developer|support,
  pinHash, totpSecret?, totpEnabled, active, tokensValidAfter?, mustChangePin, createdById?,
  lastLoginAt?, createdAt, updatedAt`). Platform-global (no `cooperativeId`, no RLS).
- First **owner** bootstrapped at startup from env `PLATFORM_OWNER_PHONE` (name from
  `PLATFORM_OWNER_NAME` default "Owner"): if no owner exists, create one with a random
  6-digit temp PIN, `mustChangePin=true`, `totpEnabled=false`; the temp PIN is logged **once**.
- **Login** `POST /api/developer/login {phone, pin, totp?}`:
  rate-limited (reuse the admin dual-axis limiter pattern); verify PIN via the existing
  `verifyPin`; if `totpEnabled` require a valid TOTP (reuse `src/lib/totp.ts`); when
  `mustChangePin`, only allow the `POST /api/developer/change-pin` endpoint until changed;
  then issue a token.
- **Token**: reuse the HMAC helpers in `src/lib/admin-auth.ts` with a payload
  `{ scope: "platform", adminId, role, iat }` (no `cooperativeId`), TTL 2h, cookie
  **`coop_dev_token`** (httpOnly, SameSite=Strict, Secure in prod). Revocation blacklist
  keyed by `sha256(token)` (reuse the Redis mechanism). `tokensValidAfter` on the
  `PlatformAdmin` row invalidates all tokens issued before it.
- **PreHandler** for `/api/developer/*`: skip login; require `X-Requested-With: XMLHttpRequest`
  on non-GET (CSRF); verify signature + expiry + scope; check revocation; live re-read the
  `PlatformAdmin` (`active`) and confirm `iat ≥ tokensValidAfter`; set `req.platformAdmin`.
  `support` role is restricted to safe methods (GET/HEAD) at the preHandler.

### 5.2 Data access (cross-tenant, RLS-safe)

- The platform console must read across tenants. It never issues unscoped queries.
- Listing uses the existing `listCooperativeIds()`; per-coop aggregates run inside
  `withCoopContext(coopId, fn)` so the same isolation applies even once FORCE RLS is enabled.
- Global writes (creating a `Cooperative`) follow the existing `createCooperative` path;
  everything tenant-scoped (config, branding, subscription, first member) runs inside
  `withCoopContext(newCoopId, fn)`.
- Two new **`SECURITY DEFINER`** read helpers are added only for the platform overview's
  cross-coop aggregate counts, mirroring the existing resolver pattern in `tenant-context.ts`
  (fail-closed, return only counts).

### 5.3 Provisioning

- Extract the onboarding final step (`src/services/handlers/session.ts:2456-2533`) into
  **`provisionCooperative(input)`** in `src/services/cooperative-provisioning.ts`:
  `{ name, code, state, country?, currency?, adminPhone, adminName }` →
  `createCooperative` + default `CooperativeConfig` + `BrandingConfig` + `Subscription` +
  a `superadmin` `Member` (wallet, random temp PIN, `nameVerified`), and enqueue a WhatsApp
  welcome. The chat `onboard` flow and the developer console both call this one function.
- **Add/promote admin**: `addCoopAdmin(coopId, { phone, name?, role: admin|superadmin })` —
  if a `Member` exists for that phone in the coop, update its role; else create the member
  (temp PIN) and send the welcome. Never returns or sets the PIN.

## 6. Data model

Mirror every change into **both** `prisma/schema.prisma` and `prisma/schema.local.prisma`
(enforced by `tests/schema-sync.test.ts`).

**`PlatformAdmin`** — see §5.1. `phone @unique`, `role String @default("developer")`.

**`PlatformPolicy`**
- `key String @id` (rule key; one row per rule)
- `value Json?` (JSON-encoded override of the platform default)
- `min Float?`, `max Float?`
- `locked Boolean @default(false)`
- `updatedById String?`, `updatedAt DateTime @updatedAt`

**`Cooperative`** (add)
- `tokensValidAfter DateTime?` (revoke-all admin sessions)
- Phase 2: `cvn String?`, `scumlStatus String?`, `dpoName String?`, `dpoPhone String?`,
  `dpoEmail String?`

**`AuditLog`** (add)
- `actorType String?` (`member | admin | superadmin | platform`) and `actorId String?`
  (the `PlatformAdmin.id` when `platform`). Existing `actorRole` writes keep working.

## 7. Rule registry & policy resolution

**`src/lib/rule-registry.ts`** declares every rule exactly once:

```ts
interface RuleDef {
  key: string; label: string; description: string;
  category: "loans" | "savings" | "withdrawals" | "governance" | "compliance" | "literacy" | "referral" | "general";
  type: "int" | "float" | "bool" | "money" | "enum" | "percent";
  unit?: string; default: number | boolean | string;
  min?: number; max?: number; coopEditable: boolean; statutory?: string;
}
```

Rules include every current `setconfig` key plus new ones:

- Phase 1 new: **`loanDurationMonths`** (max repayment period, default 12, min 1, max 60),
  `minLoanTermMonths` (default 1), `maxLoanPerMember` (money, default 0 = unlimited),
  `minMembershipMonths` (default 0).
- Phase 2 statutory: `reserveFundPercent` (default 25, min 25, `locked` by default),
  `educationFundPercent` (default 10, max 10), `dividendCapPercent` (default 5, max 5).

**`src/services/platform-policy.ts`**
- `listPlatformPolicies()` / `setPlatformPolicy(key, { value?, min?, max?, locked? })`
  (validated against the registry; `locked` implies coop non-editable).
- `getEffectiveConfig(coopId)`: for each rule, `value = locked ? platformValue
  : (coopValue ?? platformDefault)`, then clamp to `[min, max]`; returns the effective
  `CoopConfig` shape plus `{ source: "platform" | "coop", locked }` per key.
- `getCoopConfig(coopId)` is updated to apply this layer (platform default for a missing
  field, clamp to bounds). Backwards compatible: with no `PlatformPolicy` rows the result is
  identical to today.
- Caching: platform policies cached under `platform:policy:v<N>`; `setPlatformPolicy` bumps a
  `platform:policy:version` counter which is folded into the coop-config cache key, so a
  policy change invalidates all coop config caches without a key scan.

**`setconfig`** (coop super-admin, chat) is refactored to validate against the registry and to
refuse keys that are `locked` or outside bounds, instead of the current ad-hoc checks.

## 8. API surface (`/api/developer/*`)

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/login` | public | phone + PIN + TOTP → token |
| POST | `/change-pin` | must-change | set a new PIN (first login) |
| POST | `/logout` | any | revoke token |
| POST | `/refresh` | any | re-mint from a valid token |
| GET | `/me` | any | current platform admin + role |
| GET | `/overview` | any | platform-wide stats + alerts |
| GET | `/coops` | any | list coops + health summary (paged, searchable) |
| POST | `/coops` | developer/owner | provision a cooperative + first super-admin |
| GET | `/coops/:id` | any | coop detail (health, config, admins, plan) |
| GET | `/coops/:id/activity` | any | activity feed for the coop |
| POST | `/coops/:id/admins` | developer/owner | add/promote an admin or super-admin |
| PATCH | `/coops/:id/admins/:memberId` | developer/owner | change role/status |
| POST | `/coops/:id/suspend` | developer/owner | suspend the cooperative |
| POST | `/coops/:id/reactivate` | developer/owner | reactivate |
| POST | `/coops/:id/revoke-sessions` | developer/owner | set `tokensValidAfter = now` |
| GET | `/policies` | any | platform rules (value/min/max/locked) |
| PUT | `/policies/:key` | developer/owner | set a rule's default/bounds/lock |
| GET | `/admins` | owner | list platform admins |
| POST | `/admins` | owner | add a platform admin |
| PATCH | `/admins/:id` | owner | change a platform admin's role/active |

All non-GET require `X-Requested-With`; every mutating call writes an `AuditLog` row with
`actorType:"platform"`.

**Monitoring stats per coop** (covered by `GET /coops` and `/coops/:id`): members by status;
loan book (count, principal, outstanding, overdue count & amount, delinquency %); savings and
contributions; pending payouts and withdrawals; wallet/float; reserve and loan-loss provision
balances; plan/status/last-activity; alerts (AML flags, failed payouts, negative balances,
RLS enforcement status).

## 9. Console UI (`dashboard/dev/`)

Static, plain JS (same stack as `dashboard/`), served by the existing `@fastify/static`
registration (so `/dashboard/dev/` works with no new server config). Files: `dev-login.html`,
`dev-login.js`, `index.html`, `dev.js`, reusing `dashboard/style.css` + a small `dev.css`.

Pages: **Login** · **Overview** (all coops + alerts) · **Coops** (list/search) · **Coop
detail** (tabs: Health · Activity · Rules · Admins) · **Create Coop** · **Policies** ·
**Platform Admins**. The console uses `coop_dev_token` and `API_BASE = '/api/developer'`, and
is fully separate from the cooperative dashboard.

## 10. Security model

- 2FA (TOTP) mandatory for `owner`/`developer`; `support` is read-only (enforced server-side).
- CSRF header on mutations; rate-limited login (per-IP and per-account).
- `tokensValidAfter` revokes all of an admin's/coop's sessions; token blacklist reuses Redis.
- The platform token is a **distinct scope** — it is rejected by the coop admin routes, and
  coop admin tokens are rejected by `/api/developer/*` (see tests).
- Cross-tenant reads never bypass tenant context except through the two count-only
  `SECURITY DEFINER` helpers.
- Every mutating platform action is audited with actor identity + target coop.

## 11. Testing strategy (TDD)

New test files (SQLite harness; Postgres-gated where RLS is involved):

- `tests/platform-auth.test.ts` — login (PIN + TOTP), token scope, CSRF, revocation,
  `tokensValidAfter`, `support` write rejection, cross-scope rejection both ways.
- `tests/rule-registry.test.ts` — every registry key validates/round-trips; `setconfig`
  rejects out-of-bounds and locked keys.
- `tests/platform-policy.test.ts` — default/override/clamp/lock resolution; cache invalidation
  on policy change; back-compat when no policies exist.
- `tests/platform-provisioning.test.ts` — create coop + config/branding/subscription + first
  super-admin; add admin to an existing coop; promote a member; isolation preserved.
- `tests/platform-monitoring.test.ts` — stats correctness against seeded data; platform sees
  all coops, a coop admin still cannot cross tenants.
- `tests/platform-controls.test.ts` — suspend/reactivate; revoke-sessions invalidates coop
  admin tokens; audit rows written.
- `tests/cooperative-provisioning.test.ts` — the extracted service keeps the chat-onboard
  behaviour green.
- Phase 2: `tests/aml-report-type.test.ts` (CTR vs STR semantics + thresholds),
  `tests/statutory-rules.test.ts` (reserve/education/dividend/max-term defaults + locks).

Gates: `npx tsc --noEmit` clean; `npx eslint src/` 0 errors; `npm run format:check` clean;
`tests/schema-sync.test.ts` passes; focused vitest for the above, then a full-suite pass.

## 12. Rollout

1. Migrations (two schemas) + `PlatformAdmin`/`PlatformPolicy`; RLS untouched (platform tables
   are global).
2. Set `PLATFORM_OWNER_PHONE` (+ optional `PLATFORM_OWNER_NAME`) in the deploy `.env`; the
   owner is created on boot with a one-time logged temp PIN.
3. Console is reachable at `https://<DOMAIN>/dashboard/dev/` via the existing Caddy setup.
4. Phase 2 ships the corrected AML report types + statutory rules; regulator exports follow.

## 13. Risks & mitigations

- **God-mode blast radius** → mandatory 2FA, `support` read-only, full audit, per-admin and
  per-coop revocation.
- **Cross-tenant leakage** → all reads via `withCoopContext`/resolvers; explicit isolation
  tests.
- **Schema drift** → mirror both schemas + `schema-sync` test.
- **Policy cache staleness** → version-keyed cache invalidation.
- **Changing `setconfig` semantics** → additive only; identical behaviour with no policies.

## 14. Open questions

None outstanding — the four design forks (identity model, console location, rule governance,
provisioning, monitoring scope) were resolved during brainstorming.
