# Security Audit & Hardening Log

Date: 2026-08-21 · Scope: payment integrity, webhook trust, approval workflows, atomicity.

## Threat model

An attacker with any of: a stolen admin phone, provider dashboard access, network
position between provider and bot, or a concurrent race window, should not be able
to mint money, move money twice, or approve their own payout.

## Controls implemented

### 1. Webhook signature verification (fail-closed)
| Provider | Before | After |
|---|---|---|
| Flutterwave | `return true` (any forged POST minted wallet money) | `verif-hash` compared to `FLUTTERWAVE_WEBHOOK_HASH` via timing-safe compare |
| Paystack | HMAC over `JSON.stringify(body)` + `===` compare | HMAC-SHA512 over **raw bytes** with `PAYSTACK_SECRET_KEY`, timing-safe (`signaturesMatch`) |
| Monnify | HMAC over re-serialized body | SHA512 over raw body + secret, timing-safe |

- All verifiers fail closed when the secret is unset or the raw body is missing.
- Raw body captured before JSON parsing via a Fastify content-type parser
  (`src/app.ts` → `req.rawBody`).

### 2. Combined webhook listener with permanent anti-replay
`src/services/webhooks.ts` + `src/routes/payments.ts`
- One endpoint; provider detected by signature header.
- Pipeline: verify signature → parse → **INSERT-first** into `WebhookEvent`
  (PK `<provider>:<txid>`) → process synchronously → mark processed/failed.
- Replays/duplicates get HTTP 200 `duplicate` but are never reprocessed —
  dedupe survives restarts forever (DB-backed, not an in-memory cache).
- Signature failures return 401 so tampering is visible in provider dashboards.

### 3. Wallet credits are transactionally idempotent
`src/services/payments/topup.ts`
- Deterministic journal key `TOPUP-<provider>-<txid>` inserted FIRST inside the
  wallet-credit transaction; a duplicate delivery throws P2002 and rolls back
  everything. Contribution.reference remains a second unique layer.

### 4. Double-entry journal
`src/services/journal.ts`, `src/services/ledger.ts`, schema `JournalEntry`/`Posting`
- Every income/expense/appropriation books balanced debits==credits (kobo-exact).
- Idempotent on `JournalEntry.txRef` (unique).
- Nightly reconciliation alerts when books drift out of balance.

### 5. Payout idempotency keys
`Payout.idempotencyKey @unique`; deterministic references:
| Flow | Key |
|---|---|
| Loan disbursement | `TFR-LOAN-<loanId>` |
| Withdrawal | `TFR-WDR-<requestId>` |
| Death claim | `TFR-CLAIM-<claimId>` |
| Payroll stipend | `TFR-PAYROLL-<memberId>-<YYYY-MM>` |
| Pay-anyone | `PAYANY-<paymentId>` |

A retried flow can never pay twice — locally (unique constraint) and at the
provider (same transfer reference reused). Non-deterministic `Date.now()` refs
removed everywhere.

### 6. Atomic status transitions (race elimination)
Read-then-write replaced by guarded `updateMany` claims:
- Loans: each approval step and the final `super_approved_1 → approved`
  finalization are single-winner claims; disbursement additionally claims
  `disbursementStatus → processing` before touching the provider.
- Withdrawals: full saga — claim `processing` → debit wallet
  (balance-guarded decrement) → pay → mark paid; on failure **refund wallet**
  automatically and hand back for retry. Crash safety in try/catch restores funds.
- Death claims: same claim/debit/pay/refund saga.
- Pay-anyone: per-step slot claims (`approved1ById` etc. must be NULL), then an
  `approved2 → processing` claim around the transfer; failures revert to
  approved2 (retryable) instead of dead-ending in `failed`.
- Reconciliation flags anything stuck in `processing` > 24h — stuck money is
  escalated to humans, never auto-failed (the provider may still complete it).

### 7. Dual-control (self-approval blocks)
Nobody can approve/settle their own money movement:
- Own withdrawal: blocked at approve AND finalize.
- Own loan: blocked.
- Own death claim: blocked.
- Own salary: cannot be set by self; payroll runner's own stipend is skipped.
- Pay-anyone initiator already could not approve (pre-existing).

## Tests

`tests/security.test.ts` (11 tests): fail-closed signatures, raw-body HMAC,
replay dedupe end-to-end (wallet credited once), forged webhook 401 with zero
state change, duplicate payout block, concurrent finalize pays exactly once,
and all dual-control blocks. Full suite: **57/57**, `tsc --noEmit` clean.

## Residual risks / deferred work (accepted)

1. **Floats for money** — structural migration to integer kobo deferred;
   mitigated by kobo-exact rounding at every write boundary (`roundMoney`).
2. **Flutterwave `verif-hash` is not body-bound** (vendor design); replay
   protection therefore rests on the WebhookEvent dedupe layer, which covers it.
3. **Crash between provider success and DB commit** leaves a row in
   `processing` — surfaced by reconciliation within 24h for manual confirmation
   against the provider reference. No auto-retry by design.
4. **Single-super coops**: payroll can never pay the only super (by design);
   runner exclusion requires ≥2 supers for anyone to be paid.
5. **Provider credentials** (`MONNIFY_*`, `PAYSTACK_SECRET_KEY`,
   `FLUTTERWAVE_WEBHOOK_HASH`) must be set in `.env` before go-live; adapters
   refuse to operate without them.

## Pre-launch hardening (batch 4)

Real-risk fixes identified before live testing. All default OFF under
`NODE_ENV=test` so the existing suite stays deterministic.

| Risk | Control | Where |
|---|---|---|
| Phone/account takeover | TOTP 2FA on every money-out admin command (`enable2fa`, trailing 6-digit code consumed from command); `TWO_FA_REQUIRED=1` makes enrolment compulsory for admins | `src/lib/totp.ts`, `src/services/auth2fa.ts`, `admin.ts` |
| Large single payout after session hijack | Fresh-PIN threshold: payouts above `REPIN_THRESHOLD_NGN` require `verifypin` within `FRESH_PIN_MINUTES` (default 10 min) — applies to `payout` and `finalize` | `auth2fa.assertFreshPin`, `admin.ts` |
| Insider redirects payees | 24h new-beneficiary hold: first-time bank accounts cannot receive money for `NEW_BENEFICIARY_HOLD_HOURS`; records kept even when disabled | `src/services/beneficiaries.ts`, wired into withdrawals + pay-anyone |
| Stuck transfers / silent provider failures | Status poller queries each provider (`getTransferStatus`) for rows in `processing` >10 min: confirms success, refunds failures, notifies supers | `src/services/statuspoller.ts`, adapters |
| Silent insider theft | Daily movement digest to ALL super admins at `DIGEST_HOUR`: every debit yesterday, per cooperative, once/day deduped | `scheduler.runDailyDigest` |
| Runaway losses during pilot | Monthly float cap `PILOT_FLOAT_CAP` enforced inside the daily-limit fraud guard | `fraud.checkDailyPayoutLimit` |
| Misconfigured deployment | Startup env validation refuses boot without WhatsApp credentials; warns on missing providers/weak secrets | `src/lib/envcheck.ts`, wired into `index.ts` |
| Brute force / webhook floods | `@fastify/rate-limit` global 120 req/min (10k in tests), `trustProxy` behind reverse proxy | `app.ts` |

### Deployment checklist (go-live)

1. Set `NODE_ENV=production`, strong `ADMIN_JWT_SECRET`/`SESSION_SECRET` (`openssl rand -hex 32`).
2. Terminate TLS at nginx/caddy; forward to PORT; keep provider webhooks on HTTPS only.
3. In Monnify/Paystack/Flutterwave dashboards, IP-allowlist the server egress IP.
4. Start with `PILOT_FLOAT_CAP` at an amount you can afford to lose; raise it gradually.
5. Enrol every admin/super with *enable2fa* before go-live (or set `TWO_FA_REQUIRED=1`).
6. Confirm poller + digest logs appear in production within the first day.
