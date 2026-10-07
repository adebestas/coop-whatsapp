# NIBSS Direct Debit Mandates — Design

**Date:** 2026-10-07
**Status:** Approved (design) — pending spec review
**Feature:** Roadmap Phase 5, Feature 12 (NIBSS Direct Debit mandates)
**Branch:** `feat/world-class`

## Goal

Let a member authorize a **direct debit mandate** on their own bank account, so the
cooperative can automatically pull money for **recurring savings, loan repayments,
and group (VSLA/ROSCA) contributions** — instead of today's reminder-and-reply flow.

## Decisions (user, 2026-10-07)

1. **Providers:** build **both** Monnify and Paystack behind the existing
   `ProviderAdapter` abstraction, with automatic fallback via `resolveProvider`
   (Monnify primary, Paystack fallback — or whichever is healthy).
2. **What it pulls for:** all three — savings, loan repayments, group contributions.
3. **Mandate amount model:** **one flexible mandate per member with a cap**
   (`amountCap`); each debit is a variable amount up to the cap, tagged with a purpose.
4. **Authorization:** provider-hosted link sent over WhatsApp; the member authorizes
   at their bank; the provider webhook flips the mandate ACTIVE. Uses the member's
   saved bank account (`bankAccountNumber`/`bankCode`).
5. **Failure handling:** retry **until success or the mandate is cancelled**, capped at
   **once per day** (never more) to avoid hammering the account.
6. **Pre-debit notice:** none. Notify **after** each debit (success or failure).
7. **Reminder interaction:** a member with an **active mandate** is auto-debited and
   **skipped** by `runAutoSaveReminders`; members without a mandate keep today's flow.
8. **PIN:** mandate **create** and **cancel** require the member's transaction PIN.

## Addendum (user, 2026-10-07): pause controls & refunds

A member may have **already paid by bank/cheque**, so the coop must be able to stop
the auto-debit and, if the debit also pulled, refund the member.

### Pause controls (all three)
- **Pause the whole mandate:** `Mandate.status` gains `paused`; admin `pausemandate <id>`
  / `resumemandate <id>`.
- **Pause one purpose:** new `Mandate.pausedPurposes` (CSV); admin
  `pausemandate <id> <savings|loan|group>` / `resumemandate <id> <purpose>`.
- **Skip a single pending debit:** `MandateDebit.status` gains `skipped`; admin
  `skipdebit <id>` marks a pending debit skipped so it is never retried.
- The scheduler (`runMandateDebits` / `runMandateRetries`) must skip a mandate whose
  status is `paused`, skip a purpose listed in `pausedPurposes`, and never retry a
  `skipped` debit.

### Refund flow (maker-checker)
- New model `RefundRequest`: `cooperativeId`, `memberId`, `mandateDebitId?`, `amount`,
  `reason`, `status` (`pending|approved|rejected|paid|failed`), `recommendedById`,
  `approvedById?`, `createdAt`, `approvedAt?`, `paidAt?`, `payoutRef?`.
- **Admin** `recommendrefund <member code|id> <amount> <reason>` → creates a `pending`
  `RefundRequest`.
- **Super admin** `approverefund <id>` → approves and initiates a **payout to the
  member's saved bank account** (reusing the existing payout path); `rejectrefund <id>
  <reason>`.
- Refund is a payout from the coop's bank/settlement account to the member's bank
  account; every step is audited.

## Non-goals

- No USSD/SMS (WhatsApp-only program constraint).
- No admin-initiated/bulk mandates in this feature (member self-service only).
- No provider-hosted recurring subscriptions (we schedule and debit ourselves).
- No change to the existing payout/virtual-account flows.

## Architecture

### Data model (both `schema.prisma` and `schema.local.prisma`; migration + RLS)

**`Mandate`**
| field | type | notes |
|---|---|---|
| `id` | String @id @default(cuid()) | |
| `cooperativeId` | String | RLS tenant key |
| `memberId` | String | the authorizing member |
| `provider` | String | `monnify` \| `paystack` |
| `providerMandateId` | String? | Monnify `mandateCode` / Paystack `authorization_code` |
| `providerReference` | String @unique | our reference (idempotency) |
| `status` | String @default("pending") | `pending` \| `active` \| `cancelled` \| `failed` \| `expired` |
| `amountCap` | Int | kobo; max per debit |
| `bankAccountNumber` | String | |
| `bankCode` | String | |
| `bankName` | String? | |
| `accountName` | String? | resolved account name |
| `authorizationUrl` | String? | provider-hosted consent link |
| `purposes` | String @default("savings,loan,group") | CSV of enabled purposes |
| `createdAt` | DateTime @default(now()) | |
| `authorizedAt` | DateTime? | |
| `cancelledAt` | DateTime? | |
| `lastDebitAt` | DateTime? | |

Indexes: `@@index([cooperativeId, memberId])`, `@@index([cooperativeId, status])`.

**`MandateDebit`**
| field | type | notes |
|---|---|---|
| `id` | String @id @default(cuid()) | |
| `mandateId` | String | |
| `cooperativeId` | String | RLS tenant key |
| `memberId` | String | |
| `purpose` | String | `savings` \| `loan` \| `group` |
| `targetId` | String? | loanId / groupId; null for savings |
| `amount` | Int | kobo |
| `status` | String @default("pending") | `pending` \| `successful` \| `failed` |
| `providerRef` | String @unique | our debit reference |
| `providerTransactionId` | String? | provider's id |
| `attempts` | Int @default(0) | |
| `nextRetryAt` | DateTime? | daily retry schedule |
| `failureReason` | String? | |
| `createdAt` | DateTime @default(now()) | |
| `settledAt` | DateTime? | |

Indexes: `@@index([mandateId, status])`, `@@index([cooperativeId, status])`,
`@@index([status, nextRetryAt])`.

**`CooperativeConfig`** additions: `directDebitEnabled Boolean @default(false)`,
`directDebitMaxCap Int @default(0)` (0 = no extra coop cap).

**RLS:** `Mandate` and `MandateDebit` both carry `cooperativeId` → direct Stage-1
policy + FORCE-list entries in `prisma/rls/recommended_policies.sql`.

### Provider adapter extension (`src/services/payments/index.ts`)

Add to `ProviderAdapter` (all optional so existing adapters stay valid):

```ts
createMandate?(params: CreateMandateParams): Promise<MandateResult>;
debitMandate?(params: DebitMandateParams): Promise<DebitResult>;
cancelMandate?(params: CancelMandateParams): Promise<{ ok: boolean; error?: string }>;
parseMandateNotification?(body: unknown): MandateNotification | null;
parseDebitNotification?(body: unknown): DebitNotification | null;
```

- **Monnify** (`monnify.ts`): `POST /v1/disbursements/mandate` (create →
  `mandateCode`, `authorizationLink`, `mandateStatus`), `POST /v1/disbursements/debit`
  (debit → `debitStatus`), `PUT /v1/disbursements/mandate/{code}` (`action: CANCEL`),
  webhook `MANDATE_UPDATE` + successful/failed disbursement events.
- **Paystack** (`paystack.ts`): `POST /customer/authorization/initialize`
  (`channel: direct_debit` → `redirect_url`, `reference`), webhook
  `direct_debit.authorization.created` (→ `authorization_code`), `POST
  /transaction/partial_debit` (debit by `authorization_code`).

### Mandate service (`src/services/mandates.ts`, new)

- `createMandate(coopId, memberId, cap, actor)` — validates `directDebitEnabled`,
  cap ≤ `directDebitMaxCap` (when set), member has a saved bank account; calls
  `resolveProvider().createMandate`; persists a `pending` `Mandate`; returns the
  authorization link. Audited.
- `listMandates(coopId, memberId)` / `listCoopMandates(coopId)`.
- `cancelMandate(coopId, mandateId, actor)` — calls provider `cancelMandate`, sets
  `cancelled`. Audited.
- `applyMandateStatus(provider, providerMandateId, status)` — webhook-driven status flip.
- `settleDebit(providerRef, status, providerTransactionId, reason?)` — webhook-driven
  debit settlement; on success applies the purpose (below).

### Scheduler (`src/services/scheduler.ts`)

- `runMandateDebits(now)` — for each coop with `directDebitEnabled`, find members with
  an **active** mandate and a due obligation:
  - **savings:** `autoSaveEnabled && autoSaveNextDue <= now`
  - **loan:** active loan installment due (`Loan.dueDate <= now`)
  - **group:** group contribution due for the current cycle
  Create a `pending` `MandateDebit` (amount = min(due, `amountCap`)) and call
  `debitMandate`. Advance the source's next-due only on success.
- `runMandateRetries(now)` — `failed` debits with `nextRetryAt <= now` → retry once,
  set `nextRetryAt = now + 1 day`.
- Both wired into `runSchedulerTick`.
- `runAutoSaveReminders` skips members with an active mandate.

### Webhooks (`src/services/webhooks.ts`)

Extend the existing `/webhooks/payments` pipeline with a **mandate branch** (after the
credit parser returns null): signature-verified, `WebhookEvent`-deduped, then
`parseMandateNotification` → `applyMandateStatus`, or `parseDebitNotification` →
`settleDebit`. Always 200 for irrelevant/duplicate events; 4xx only on signature failure.

### Accounting (the key integration)

A successful debit is an **incoming funding event**. `settleDebit` credits the member's
wallet through the **existing** top-up credit path (same journal as a bank transfer:
DEBIT provider settlement / CREDIT `member_wallet:<walletId>`), then applies the purpose
via the **existing** services:
- **savings** → the contribution path used by `save`
- **loan** → `repayLoan`
- **group** → `contributeToGroup`

No new money-movement logic; every path already posts a balanced `postJournal` pair and
calls `audit()`.

### Commands

- **Member** (guarded money block, PIN-confirmed, rate-limited, freeze-guarded):
  `mandate <cap>` (create + return link), `mandates`, `mandatestatus <id>`,
  `cancelmandate <id>`.
- **Admin:** `mandates` (coop-wide), `pausemandate <id>`.
- Menus updated in `session.ts`.

## Security

- Mandate create/cancel require the transaction PIN; rate-limited; blocked when the
  member is frozen/suspended.
- Cap enforced server-side: never debit more than `amountCap` or more than the amount due.
- Every debit and status change is audited.
- Webhook signature verification + `WebhookEvent` idempotency (reused).
- Provider fallback via the existing circuit breaker.

## Testing

Mock provider adapter (no live calls). Cover:
- mandate create → pending + link; authorize webhook → active; cancel → cancelled.
- debit success → wallet credited + purpose applied (savings/loan/group).
- debit failure → `failed` + `nextRetryAt` +1 day; retry succeeds.
- cap enforcement (never over `amountCap`).
- reminder suppression for members with an active mandate.
- webhook idempotency (duplicate delivery acked, not reprocessed).
- PIN/rate-limit/freeze guards.

Full gate per task: `npm run typecheck` clean · `npm run lint` 0 errors · targeted
tests green · full suite green · schema-sync green.

## Phasing (one feature, built in order)

1. Adapter + `Mandate`/`MandateDebit` model + migration + RLS + lifecycle service + webhook + **savings** auto-debit.
2. **Loan** repayments.
3. **Group** contributions.
4. Admin view + README.

## Open risks

- **Retry-until-success** can repeatedly fail on a member with no funds; mitigated by
  the once-per-day cap and post-failure notifications. Revisit if it proves noisy.
- Provider mandate APIs differ (Monnify explicit mandate vs Paystack authorization);
  the adapter normalizes both to one `Mandate` shape.
- Live provider access is not yet confirmed; the mock adapter keeps the feature fully
  testable and it flips to live when credentials land.
