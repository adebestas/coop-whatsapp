# WhatsApp Bot Sandbox Simulator

**Date:** 2026-11-04
**Status:** Approved design, pending implementation plan
**Related:** `src/lib/messaging.ts`, `src/services/conversation.ts`, `src/routes/developer.ts`, `dashboard/dev/`, `src/services/payments/index.ts`, `src/lib/ai*.ts`, `prisma/schema.prisma`

## Problem

The Platform Console can create cooperatives, set policy, and inspect totals, but it
cannot exercise the WhatsApp bot's conversation flows. Today the only ways to test a
change to a handler are:

1. Use Meta's test number — capped at 5 allowlisted recipients, bound to a 24-hour
   session window, and still spends real API quota.
2. Use a real cooperative — risks polluting real members, wallets, loans, and
   outbound messages.

Neither is acceptable for verifying state-machine changes, loan flows, guardrails, or
cross-member notifications. We need a first-class, isolated sandbox.

## Goal

An owner or developer can open **Sandbox** in the developer console, pick a seeded
persona, send a message, and see every outbound message the bot would send — including
multi-turn flows, buttons, documents, and messages addressed to *other* sandbox
personas. The real `handleMessage` path runs, real session state advances, and real AI
can be used, but no real WhatsApp/Telegram, payment, insurance, email, or storage call
ever leaves the process. One click resets the fixtures.

## Non-goals

- Not a webhook inspector, raw-event replay tool, or DLQ (feature #5).
- No impersonation of real members. Fixed, seeded personas only.
- No inbound audio, image, document, or location simulation in v1 — text only.
- No persistent transcript table in v1; transcripts live in the browser per persona.
- One sandbox cooperative per platform. Not a multi-tenant test harness.
- No feature-flag system; access is role-gated by the existing platform auth.

## Decisions (agreed with product owner)

| Topic | Decision |
|-------|----------|
| Sequence | Simulator first end-to-end; scheduler, liquidity, diagnostics, webhook replay follow as separate specs |
| Data safety | Dedicated sandbox cooperative with seeded personas, never real member data |
| Identities | Fixed seeded personas + one-click reset |
| AI | Real Groq path when configured, per-turn deterministic toggle, path badge |
| Transport | In-process `handleMessage()`, not the `/webhook` HTTP route |
| External services | Hard-block payments, insurance, email, and object storage; return canned results |
| Isolation | `Cooperative.isSandbox`; excluded from platform totals, schedulers, regulator output, liquidity, payouts |
| Transcript | Browser-local per persona; authoritative state is the real `Session` row |
| Reset | Idempotent DMMF-driven delete of sandbox-coop rows, then reseed |

## Architecture

```
POST /api/developer/sandbox/message
        │
        ▼
developerApiRoutes preHandler        (platform token, role, CSRF header)
        │
        ▼
sandboxGuard                         (checkRateLimit + RedisMutex.acquire)
        │
        ▼
runInSimulatorScope(persona.phone,
  runInSandbox(coopId, () => handleMessage(...), { aiEnabled }))
        │                                   │
        │                                   ├── isSandboxMode() = true
        │                                   ▼
        │                            conversation.ts → handlers
        │                                   │
        │                    ┌──────────────┼───────────────┐
        │                    ▼              ▼               ▼
        │            messaging.ts     payments/email    AI (real)
        │            capture all      sandbox adapter   Groq or deterministic
        │                    │
        ▼                    ▼
{ messages[], state, ai path, durationMs }
```

Two independent runtime scopes are used:

- **Simulator scope** (`runInSimulatorScope`) captures outbound messages and prevents
  any channel send.
- **Sandbox scope** (`runInSandbox`) marks external adapters as simulated.

The route always installs both. Each scope is usable alone, but the simulator route is
the only caller in v1.

## Data model

Add to both `prisma/schema.prisma` and `prisma/schema.local.prisma`:

```prisma
model Cooperative {
  // ...
  isSandbox Boolean @default(false)

  @@index([isSandbox])
}
```

Migration: additive, `isSandbox` defaults to `false`, no backfill, safe to deploy
independently of the route. Name it with the repo's timestamp convention
(`prisma/migrations/<timestamp>_sandbox_cooperative/`). Local SQLite gets the
equivalent `db push` / schema edit.

No other tables are added in v1. There is deliberately no `SandboxTurn` model.

### Isolation rules

The sandbox cooperative is excluded from:

- `platformOverview()` totals and alerts.
- `listActiveCooperativeIds()` unconditionally, and therefore every scheduler job
  (loan reminders, auto-save, statements, digests, reconciliation).
- Regulator packs, SCUML/compliance register counts.
- Any liquidity, reserve, payout, or dividend aggregate.
- `createCoop`/`setCoopConfig` may never set `isSandbox`; only the sandbox
  provisioner creates it. Config PATCH ignores/rejects an `isSandbox` field.

`listActiveCooperativeIds()` skips cooperatives whose `isSandbox` flag is true,
and `platformOverview()` excludes them from totals and alerts while still
returning them in its `coops` list so the console can show a badge.
`listCoops()` includes them with a `sandbox` flag. The PostgreSQL
`app.list_cooperative_ids()` function is unchanged.

## Sandbox runtime

### `src/lib/sandbox.ts`

```ts
interface SandboxOptions { aiEnabled?: boolean }       // default true
interface SandboxMeta { aiPath: "ai" | "rules" | "guardrail" }

runInSandbox<T>(
  cooperativeId: string,
  fn: () => Promise<T>,
  options?: SandboxOptions,
): Promise<{ result: T; meta: SandboxMeta }>

isSandboxMode(): boolean
sandboxCooperativeId(): string | null
sandboxAiEnabled(): boolean
noteSandboxAiPath(path: SandboxMeta["aiPath"]): void
```

Backed by `AsyncLocalStorage`. Nested calls keep the innermost cooperative id and
inherit the outer `aiEnabled`; an inner scope can turn AI off but never back on. This
module has no dependencies on Prisma or the conversation layer.

### AI toggle and path reporting

`groqAvailable()` in `src/lib/groq.ts` is the single choke point every AI module uses
(`aiEnabled()`, `ai-loan`, `ai-query`, `ai-support`, `ai-notice`, `ai-insights`). It
returns `false` when `isSandboxMode()` is true and `sandboxAiEnabled()` is false, so
the whole turn falls back to deterministic rules without touching the network.

AI path reporting is explicit at each entry point (some AI modules use `groqFetch`,
others call `fetch` directly):

- On a successful provider response, the entry point calls
  `noteSandboxAiPath("ai")`.
- On a guardrail refusal, it calls `noteSandboxAiPath("guardrail")`.
- If neither is recorded, the route reports `rules`.

This keeps the badge honest and avoids guessing from the reply text.

### Capture all outbound messages

The current `runInSimulatorScope(phone, fn)` captures only sends where
`to === phone`. That misses cross-member notifications (guarantor alerts, admin
notices, approvals addressed to another persona), which would then fall through to a
real WhatsApp call.

Change the scope to capture **every** outbound message while it is active:

- `SimulatorStore` keeps the initiating persona phone for context.
- Each captured `SimulatorMessage` gains `to: string` and an optional `toName` filled
  by the route from the persona registry.
- Once a simulator scope is active, no branch may reach `sendWhatsApp`,
  `sendTelegramMessage`, `sendWhatsAppDocument`, or `sendTelegramDocument` —
  regardless of recipient.
- Telegram sends are captured the same way (`to` starts with `tg:`).

This is a small, contained change in `src/lib/messaging.ts` covering `sendText`,
`sendDocument`, interactive buttons, and flow messages.

### External-service guards

| Service | Guard location | Sandbox behavior |
|---------|----------------|------------------|
| WhatsApp / Telegram | `src/lib/messaging.ts` capture | Recorded, never sent |
| Payments (Monnify/Paystack/Flutterwave) | `resolveProvider()` in `src/services/payments/index.ts`; adapter in `src/services/payments/sandbox-adapter.ts` | Returns `sandboxAdapter` |
| Email | `src/services/exports.ts` (`nodemailer.createTransport`) and regulator mailer | Returns simulated success, no SMTP |
| Insurance (CubeCover) | `src/services/insurance/cubecover.ts` and `src/services/insurance/index.ts` | Canned quote/policy response |
| Object storage | `src/lib/s3.ts` (`uploadBufferToS3`) | No-op, simulated key |
| Backups | `src/services/backup.ts` (`uploadToS3`) | No-op when invoked from a sandbox scope; scheduled backups never include the sandbox |
| AI (Groq) | not guarded | Real call when enabled and configured |

`resolveProvider()` checks `isSandboxMode()` **before** any health probe and returns
the sandbox adapter immediately, so no provider availability call is made. The adapter
implements the full `ProviderAdapter` interface and is deterministic:

- `createVirtualAccount` → `{ accountNumber: "0000000000", bank: "Sandbox Bank",
  provider: "sandbox" }`
- `createPayout` / transfer → success with `SBX-<reference>`
- `resolveAccount` → the member's sandbox name
- `createMandate` → a fake consent URL on `sandbox.invalid`
- `listBanks` → `staticBanks()`

Every method returns without `fetch`. A test asserts no network call occurs.

### Failure posture

If a sandbox-scoped code path somehow reaches a real adapter (for example a new
provider added without a guard), the adapter's own tests should fail before merge. In
production the route is still protected by the capture scope, which is checked before
any channel call. Defense in depth, not a single choke point.

## Sandbox cooperative and personas

Provisioned on demand by `ensureSandbox()` in `src/services/sandbox.ts`.

| Field | Value |
|-------|-------|
| `name` | `Sandbox Cooperative` |
| `code` | `SANDBOX` (unique; used as the join code) |
| `country` / `currency` / `locale` | `NG` / `NGN` / `en` |
| `status` | `active` |
| `adminPhone` | `2349000000005` |
| `isSandbox` | `true` |
| config | `requireGuarantors: true`, `minGuarantors: 1`, `autoApproveLoans: false`, `minContribution: 200000` |

Personas (all phones are synthetic and reserved; none are in `ALLOWED_TEST_NUMBERS`):

| Key | Name | Phone | Role | Seeded state | Purpose |
|-----|------|-------|------|--------------|---------|
| `new_joiner` | New Joiner | `2349000000001` | none | no `Member`, no `Session` | Join flow, join-code entry |
| `active_saver` | Ada Active | `2349000000002` | member | wallet ₦50,000; 3 contributions | Balance, save, withdraw, statement |
| `overdue_borrower` | Bola Borrower | `2349000000003` | member | wallet ₦2,000; loan ₦120,000, 10 days overdue | Repayment, arrears, reminders |
| `guarantor` | Grace Guarantor | `2349000000004` | member | wallet ₦20,000; guarantees borrower's loan | Guarantor approval/notification |
| `admin` | Sam Superadmin | `2349000000005` | superadmin | wallet ₦0; PIN `1234` | Admin queues, approvals, broadcasts |
| `plain_member` | Peter Plain | `2349000000006` | member | wallet ₦5,000 | Baseline member flows |
| `pending_applicant` | Paul Pending | `2349000000007` | member | wallet ₦30,000; loan ₦80,000 `pending` | Admin approval flow |

Seed rules:

- Balances are stored in kobo.
- Every member persona has transaction PIN `1234`, stored with `hashPin()`; no TOTP
  secret is set. This makes money-out flows testable without a live authenticator.
- `admin` is the cooperative superadmin; `guarantor` is the only guarantor on
  `overdue_borrower`'s loan.
- Only one active loan and one pending loan exist at seed time.
- All personas share the sandbox cooperative; there is no cross-coop routing.
- Provisioning is idempotent: if the coop exists, missing personas/wallets/config are
  repaired, never duplicated.
- Seeded records are tagged by deterministic names/phones so reset can find them.

## Reset

`resetSandbox()` must be safe, repeatable, and scoped.

1. Acquire the reset mutex with `RedisMutex.acquire("sandbox:mutex:reset", ttl)`;
   refuse (`409`) if a turn is in flight. Turns use
   `RedisMutex.acquire("sandbox:mutex:turn:<personaId>")`.
2. Enumerate Prisma models via `Prisma.dmmf.datamodel.models`; select those with a
   scalar `cooperativeId` field. This stays correct as the schema grows.
3. Run retry passes: for each selected model, `deleteMany({ cooperativeId })`. A
   model blocked by a foreign key is retried on the next pass. Stop when a pass makes
   no progress.
4. Delete orphan rows that are phone-keyed rather than coop-keyed: `Session` for all
   persona phones, and `WebhookFailure` rows whose `phone` is a persona phone.
   `ProcessedInbound` has no phone/coop column and is left untouched.
5. Do **not** delete the `Cooperative` row; keep its id stable for the UI.
6. Clear cached sandbox state: `invalidateCoopMeta(coopId)` and rate-limit keys under
   `sandbox:rl:*`. Never clear `sandbox:mutex:*` (the reset mutex is held).
7. Reseed personas, wallets, loans, and config; return deletion counts per model.

The retry-pass delete is chosen over disabling FK checks because it needs no owner
connection and works identically on SQLite (tests) and Postgres. If a pass cannot
finish, the reset aborts with the blocking model names in the error and leaves the
sandbox in its previous state where possible.

Reset writes a `writePlatformAudit` entry with the acting platform admin, action
`sandbox.reset`, and the deletion summary. No message text is audited.

## API

All routes live in the existing `developerApiRoutes` preHandler, so platform token,
revocation, live-admin, `X-Requested-With`, and support read-only checks already
apply. Support may `GET`; it cannot `POST` because the preHandler blocks non-GET.

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| `GET` | `/api/developer/sandbox` | any platform admin | Status, coop, personas, AI availability |
| `GET` | `/api/developer/sandbox/state?personaId=` | any | Session, wallet, loans for the inspector |
| `POST` | `/api/developer/sandbox/message` | owner, developer | Run one turn |
| `POST` | `/api/developer/sandbox/reset` | owner, developer | Reset and reseed |

### `GET /api/developer/sandbox`

Illustrative shape; the response contains all personas:

```json
{
  "cooperative": { "id": "c...", "name": "Sandbox Cooperative", "code": "SANDBOX", "status": "active" },
  "personas": [
    { "id": "active_saver", "name": "Ada Active", "phone": "2349000000002", "role": "member",
      "walletKobo": 5000000, "loan": { "count": 0, "overdue": 0 } }
  ],
  "ai": { "available": true, "provider": "groq" },
  "limits": { "maxTextChars": 500, "turnsPerMinute": 60, "resetsPerMinute": 10 }
}
```

### `POST /api/developer/sandbox/message`

Request:

```json
{ "personaId": "active_saver", "text": "balance", "aiEnabled": true }
```

Response (illustrative; exact bot copy comes from the handlers):

```json
{
  "messages": [
    { "to": "2349000000002", "toName": "Ada Active", "type": "text",
      "text": "Your wallet balance is ₦50,000.00", "timestamp": "2026-11-04T10:00:00.000Z" }
  ],
  "state": {
    "session": { "state": "main_menu", "data": null },
    "wallet": { "balanceKobo": 5000000, "totalSavedKobo": 5000000 },
    "loans": []
  },
  "ai": { "mode": "deterministic", "path": "rules" },
  "durationMs": 42
}
```

Rules:

- `text` is trimmed, required, and capped at 500 characters.
- `personaId` must be one of the registry keys; unknown ids are `400`.
- `aiEnabled` defaults to `true`; `false` forces the deterministic/rules path.
- `ai.mode` is `live` when a provider call ran, otherwise `deterministic`.
- `ai.path` is `ai`, `rules`, or `guardrail` (guardrail refusal).
- Turns for the same persona are serialized with a per-persona mutex; a second
  concurrent turn returns `409`.
- Rate limit: `checkRateLimit("sandbox:rl:turn:<adminId>", 60, 60)`.
- If the sandbox cannot be provisioned, return `503` with a safe message.

### `POST /api/developer/sandbox/reset`

Rate limit `checkRateLimit("sandbox:rl:reset:<adminId>", 10, 60)`. Returns:

```json
{ "ok": true, "deleted": { "Member": 7, "Wallet": 7, "Loan": 2 }, "personas": 7 }
```

### `GET /api/developer/sandbox/state?personaId=`

Returns the same `state` object as a turn, plus `ai` availability. Used on page load
and after reset.

## UI

New **Sandbox** item in the Platform Console sidebar (visible to owner and developer;
support sees it read-only). New page in `dashboard/dev/dev.js`, the page switch, and
styles in `dev.css`.

Layout, desktop:

- **Left — Personas.** Cards with avatar initials, name, role, phone, wallet, loan
  badge. Selecting one loads its state and transcript. A **Reset sandbox** button with
  a confirmation dialog sits at the bottom.
- **Center — Conversation.** WhatsApp-style transcript: inbound bubbles right (persona),
  outbound left (bot). Buttons render as labelled chips, documents as file rows, and
  flow messages show their header/body/footer. A message addressed to another persona
  gets a visible `to <name>` tag and an amber accent so cross-member sends are obvious.
  Composer at the bottom with an **AI** toggle and quick-command chips:
  `menu`, `balance`, `save 2000`, `loan 50000 3`, `myloans`, `trend`, `help`.
  Enter sends; Shift+Enter inserts a newline.
- **Right — State inspector.** Session state and data, wallet balance/total saved, and
  a loans table (amount, outstanding, status, due date). Shows the AI badge
  (`Live` / `Deterministic` / `Guardrail`) and turn duration for the last turn.
  A small "last reset" timestamp.

Behavior:

- Transcripts are kept in `sessionStorage` keyed by persona id, so switching personas
  or refreshing does not lose the visible conversation. No server-side transcript.
- Empty state explains the sandbox and offers the first quick command.
- Support users see the page, personas, state, and the browser-local transcript (if one
  exists), but the composer is disabled with a read-only banner.
- Mobile: panes stack; the persona picker becomes a horizontal scroller.
- Accessibility: transcript is `aria-live="polite"`, controls have labels, chips are
  real buttons, focus returns to the composer after send.

The Cooperatives list gets a **Sandbox** badge and a link to the Sandbox page; the
sandbox is never counted in overview cards.

## Security and privacy

- No real member data, phone numbers, or PII is used. Persona names and phones are
  synthetic and documented.
- No external money movement, email, insurance, or storage call in sandbox mode.
- AI is the only outbound network call; it is opt-out per turn. Sandbox text is
  synthetic, so no customer data is sent to Groq.
- Message bodies are never written to server logs or platform audit. Only persona id,
  actor id, outcome, and duration are logged.
- The existing platform preHandler enforces auth, token revocation, CSRF, and
  support read-only. No new auth path is added.
- `isSandbox` cannot be set through cooperative create/config endpoints.

## Observability

Add to `src/lib/metrics.ts` using the existing counter/gauge helpers (it has no
histogram type in v1):

- `sandbox_turns_total{result}` (`ok`, `error`, `guardrail`, `rate_limited`)
- `sandbox_last_turn_duration_ms` gauge
- `sandbox_resets_total`
- `sandbox_external_block_total{service}`

Structured console log per turn: `{ actorId, personaId, result, durationMs, messageCount }`.
Reset logs deletion counts.

## Testing

New tests:

| File | Covers |
|------|--------|
| `tests/sandbox-provisioning.test.ts` | Idempotent provisioning, persona/phone/wallet/loan fixtures, config |
| `tests/sandbox-isolation.test.ts` | Sandbox excluded from `platformOverview` totals/alerts and `listActiveCooperativeIds`; included in `listCoops` with flag |
| `tests/sandbox-simulator.test.ts` | A turn advances session state; captured messages include a cross-persona recipient; scoped capture blocks a send to a non-persona phone |
| `tests/sandbox-guards.test.ts` | `resolveProvider` returns the sandbox adapter; no `fetch`; virtual account/payout/mandate shapes; email no-op |
| `tests/sandbox-reset.test.ts` | Reset clears wallets/loans/sessions and reseeds; coop id stable; second reset is clean |
| `tests/developer-sandbox-routes.test.ts` | Auth 401, support 403 on POST/200 on GET, unknown persona 400, 500-char cap, per-persona 409, rate limit 429 |

Test constraints:

- Run targeted suites through `npm test -- <paths>` so `pretest` regenerates the local
  Prisma client.
- Spy/mock the channel senders and assert zero calls to WhatsApp/Telegram and zero
  `fetch` in sandbox turns.
- All money assertions in kobo.
- Manual QA: owner and developer can run a loan flow; support is read-only; reset
  restores balances; overview totals do not move.

Then run `npm run typecheck`, `npm run lint`, and `npm run format:check`.

## Rollout and rollback

- The migration is additive and defaults to `false`; it can ship before the route.
- No environment flag. Access is limited to owner/developer by existing auth.
- Rollback: remove the Sandbox route and UI page. The `isSandbox` column is inert if
  unused, and the sandbox coop remains excluded from aggregates.
- Deleting the sandbox cooperative is not part of the UI; it can be done manually via
  the reset delete path if ever needed.

## Acceptance criteria

1. Owner/developer opens Sandbox, sees seven personas and the sandbox coop.
2. Sending `balance` as `active_saver` returns the seeded balance and no network call
   is made to WhatsApp.
3. A loan application as `active_saver` advances session state; the state inspector
   reflects it after reload.
4. A flow that notifies another persona shows the message in the transcript tagged
   with the recipient's name.
5. Toggling AI off produces `ai.mode = "deterministic"`; guardrail-refused text
   produces `ai.path = "guardrail"`.
6. Reset restores wallets, loans, and sessions, and is safe to run twice.
7. The sandbox never appears in platform totals, alerts, scheduler runs, or regulator
   counts.
8. Support can view but cannot send or reset.
9. Typecheck, lint, format, and the new targeted tests pass.

## Follow-up specs (not in this plan)

- **#2 Scheduler / Job Manager.** BullMQ `getJobSchedulers()` plus one-off jobs cloned
  from a scheduler's template for Run Now; pause/resume, last run/duration/next run,
  failure counts; must skip sandbox.
- **#3 Cross-coop Liquidity Cockpit.** Extend `platformOverview`/`coopStats` with
  per-coop liquidity, concentration, and FX; exclude sandbox; alert thresholds.
- **#4 API Diagnostics.** Provider health (WhatsApp, payments, AI, DB, Redis), latency,
  recent errors, `/metrics` snapshot, and guarded "test connection" actions.
- **#5 Webhook Monitor & Replay.** New `WebhookEvent` table with raw body, headers,
  status, idempotency key, and replay count; list/filter, single and bulk replay with
  dedupe and throttling; 24–72h retention; sandbox-aware.

## Open questions

None. All design decisions above are resolved.
