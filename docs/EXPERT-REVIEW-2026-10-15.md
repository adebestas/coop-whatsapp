# coop-whatsapp — Multi-Expert Diagnostic Review

**Date:** 2026-10-15
**Scope:** whole project (branch `feat/world-class`, HEAD `f52dda3`)
**Method:** six independent specialist reviews (security/tenancy, financial correctness, architecture/concurrency, QA/test integrity, DevOps/production readiness, compliance/data protection), each reading the real code. Read-only.

> **Verdict: NOT ready to deploy or launch.** The code is green (760 tests) but the panel found **~15 Critical** issues across every domain — several of which mean the bot would not work in production at all, and several of which can move money incorrectly.

---

## A. Critical — must fix before any deploy

### A1. WhatsApp webhook signature uses the WRONG secret → the bot receives nothing in production
`src/routes/webhook.ts:27-37` verifies `X-Hub-Signature-256` with `WHATSAPP_TOKEN` (the Cloud API bearer token). Meta signs with the **App Secret**. No `WHATSAPP_APP_SECRET` exists anywhere. Every genuine Meta POST returns 401 and is dropped. *(DevOps)*

### A2. RLS is enabled but NOT enforced — tenant isolation is app-level only
`prisma/migrations/*rls*` use `ENABLE` without `FORCE`; the app connects as the table **owner**, which bypasses every policy (`src/lib/prisma.ts:75-82`; no `DATABASE_OWNER_URL` set). The startup canary warns and boots anyway (`src/index.ts:100-112`). Every `withCoopContext` is currently a no-op for isolation. *(Security)*

### A3. Eight tenant tables have `cooperativeId` but NO RLS policy at all
`InsurancePolicy`, `InsuranceClaim`, `LiteracyCertificate`, `OmbudsmanCase`, `PhoneChangeRequest`, `FederationMembership`, `FederationPosting`, `FederationLoan` (plus child tables `DividendVoteBallot`, `DeathClaimApproval`, `GuarantorVerification`, `DeductionWaiver`, `DataConsent`). Even after the RLS cutover they stay cross-tenant. *(Security)*

### A4. Money paths key off `phone` alone, not `(cooperativeId, phone)` → wrong-tenant money movement
For a phone in two co-ops, `withdrawals.ts:52,65,113,147`, `manualcredit.ts:38,124,244`, `admin.ts:192,232`, `security-hardening.ts:58` use bare-phone `findFirst`, ignoring the selected co-op. A withdrawal can be requested/approved against the *other* co-op's member/wallet/books. *(Security)*

### A5. Loans are amortised against a balance that already contains the interest → loans never close, members overpay
`loans.ts:729` sets `balance = totalRepayable` (principal+interest), but repayment (`loans.ts:850-868`) treats it as principal and decrements only the principal portion. Worked example: ₦100k/3mo @6% → after the 3 contractual installments the balance is still ~₦1,016, `isPaid` never true, a 4th installment is demanded (~33% overpay). *(Finance)*

### A6. `recordLedger` books every income as cash-in at `assets:bank` → journal diverges from reality
`ledger.ts:55-65` hard-codes the income counter-leg to `assets:bank`. Withheld loan fees/premiums are booked as money *in* though no cash arrived; wallet-funded interest/fines debit `assets:bank` too. The journal bank asset is overstated (e.g. ₦3,000 on a ₦100k loan) and `assets:loan_portfolio` understated. `getBankAccountBalance` — the precondition for dividend runs and PEARLS liquidity — is derived from this overstated figure. *(Finance)*

### A7. Dividends computed on cumulative all-time profit → the same profit can be distributed repeatedly
`dividends.ts:108-138` uses all-time `computePnl` and only subtracts pools dated within the current calendar year, so on 1 Jan the base resets while profit persists. A coop can distribute more than the period's profit (a distribution out of capital). *(Finance)*

### A8. Provider collections run INSIDE DB transactions → rollback after the call loses the idempotency guard (double charge)
`scheduler.ts:133` wraps the per-coop body in `withCoopContext` (a tx); `runMandateDebits` inserts the `pending` row **and then awaits the provider debit** (`scheduler.ts:176-201,363-410`). If the provider accepts but the tx aborts, the `providerRef` row rolls back and the next tick **charges again**. *(Architecture)*

### A9. Payment-provider HTTP has no timeout, called while holding a transaction
`monnify.ts:120`, `paystack.ts:73`, `flutterwave.ts:119` call `fetch` with no `AbortSignal`. A hung socket blocks the tx past Prisma's 20s timeout; with `connection_limit=10` a few stuck rows exhaust the pool for every tenant. *(Architecture)*

### A10. `deductions.ts` writes `loan.balance` with an unguarded read-modify-write (lost update)
`deductions.ts:575-585` reads then writes an absolute balance with no `gte` guard / atomic decrement; a concurrent `repayLoan` or second batch is silently overwritten. *(Architecture)*

### A11. `runTransferPolling` books without checking the guarded update's result (double books) and aborts the whole run on one row
`statuspoller.ts:62-99` ignores the `updateMany` count then unconditionally runs `audit`+`recordLedger`+`notifySupers`; a P2002 in the `externalPayment` branch throws out of `forEachCoop`, stopping polling for every remaining coop. *(Architecture)*

### A12. Every real provider money movement is stubbed in tests → an entire bug class ships green
`tests/setup.ts:63-92` globally mocks `resolveProvider`; no test exercises the real HTTP request construction of `payout`/`createVirtualAccount`/`resolveAccount`. A units/currency/URL regression in the money-out path passes the whole suite. *(QA)*

### A13. Dockerfile (and its boot-time migration) is never used → migrations do not run on deploy
`render.yaml` uses `runtime: node` (not `docker`), so the Dockerfile `CMD node scripts/db-migrate.mjs && node dist/index.js` is dead code. A schema-changing release boots against the old schema. *(DevOps)*

### A14. Destructive migration drops columns on any populated DB
`20261002000000_loan_stages_account_officers/migration.sql:2,9` drops `Member.tier` and `LedgerEntry.status` (both populated) with no snapshot/gate, running automatically at boot. *(DevOps)*

### A15. Voice notes and messages are sent to a third-party LLM (Groq) before any consent
`webhook.ts:93-110` transcribes every voice note via Groq *before* the member is resolved; `conversation.ts:431,460` translate every non-English message via Groq *before* the consent gate. The only consent collected is "receive messages" — no AI/onward-transfer consent exists (`DataConsent` enum has no such value). NDPA/NDPR breach. *(Compliance)*

### A16. No sanctions / PEP screening anywhere
Repo-wide search for `sanction|watchlist|pep|screening` returns nothing. Onboarding and AML never screen members, guarantors, next-of-kin, or payees. Core CFT control missing. *(Compliance)*

### A17. KYC is effectively absent — BVN never collected
`Member.bvn` exists but no code writes it; onboarding collects only name/email/birthday/NOK; `nameVerified` gates nothing in lending/withdrawals. The bot *tells* members to "complete BVN verification" for a tier that doesn't exist. *(Compliance)*

---

## B. Important (by domain)

**Security:** insurance-claim admin handlers unscoped (latent IDOR, `insurance/index.ts:418-448`); Paystack webhook idempotency falls back to `Date.now()` → duplicate-credit window (`paystack.ts:235`, `webhooks.ts:324`); export-download route serves legacy filenames cross-coop (`routes/exports.ts:73-76`); test-only money printer exported from a production module (`cooperative.ts:299-370`); device-binding hard-block lockout (`security-hardening.ts:55-90`); a live Neon credential sits in a commented `.env` line.

**Finance:** insurance premiums/claims booked as coop P&L though the coop is only an agent (`insurance/index.ts:57-58,377-379`); insurance charges not idempotent + post-charge DB failure leaks the premium (`insurance/index.ts:111,135`); claim payout can credit more than approved (`insurance/index.ts:361`); federation interest ignores repayment timing and can roll back a full repayment (`federation/index.ts:82-88,412-459`).

**Architecture:** P2002-catch idempotency inside a shared tx is unsafe on Postgres (`topup.ts:150-200`); `RedisMutex` can't guarantee single-processing (no owner token, 30s TTL < work, fail-closed) (`redis-mutex.ts:20-83`); withdrawal guard documented but not implemented (no `FOR UPDATE`) (`withdrawals.ts:100-147`); nested `withCoopContext` for a different tenant overwrites the RLS GUC without restoring (`tenant-context.ts:49-56`); bookkeeping/audit failures swallowed.

**QA:** `flutterwave.ts` core paths have zero tests (the only non-NGN provider); several money commands untested through `handleMessage` (`insurance`, `repay`, `groupcontribute`, `grouploan`, `buypolls`, `motionvote`, `joinunit`, `skipmonth`, `confirmclaim`, `validate`, `resolve`, `candidate`); scheduler job bodies never tested; Redis-path correctness untested; `InsuranceService` beyond purchasePlan/handleWebhook untested; hand-maintained `beforeEach` table lists have drifted.

**DevOps:** admin dashboard unserved outside Docker (`app.ts:151` hardcodes `/app/dashboard`); backups truncated/ephemeral/unverified (`backup.ts:96,148-219`); `uncaughtException` logged but not fatal (`index.ts:69-71`); graceful shutdown never completes (`index.ts:145-208`); queue retries misconfigured (`queue.ts:66`); CI deploy gates cosmetic (`autoDeploy: true`); DB connection budget likely exceeded.

**Compliance:** AML reports mislabeled (STR vs CTR) and the CBN payload carries the wrong amount (`aml.ts:263-267,431,441`); AML detection doesn't block/delay the transaction (`withdrawals.ts:486-501`); data-retention job is dead code (`scheduler.ts:660` — `status:"inactive"` never assigned); right-to-erasure incomplete and unlogged (`admin-actions.ts:499-531`); consent records semantically wrong.

---

## C. Cross-cutting themes

1. **Tenant isolation is not actually enforced** (A2/A3/A4) — the single biggest risk; everything else assumes it.
2. **Money correctness has real bugs** (A5/A6/A7/A8/A10/A11) — loans, the ledger, dividends, and provider collections.
3. **The test suite gives false confidence** (A12 + QA) — the money-out path and several commands are effectively untested.
4. **Production wiring is broken** (A1/A13/A14 + DevOps) — the bot wouldn't receive messages, migrations wouldn't run, and a destructive migration would fire.
5. **Compliance is largely absent** (A15/A16/A17) — no AI consent, no sanctions screening, no KYC.

## D. Recommended remediation order

1. **A1** (webhook secret) — without it, nothing works in production.
2. **A2/A3/A4** (RLS enforcement + missing policies + phone-scoping) — tenant isolation.
3. **A5/A6/A7** (loan amortisation, ledger counter-legs, dividend base) — money correctness.
4. **A8/A9/A10/A11** (provider I/O out of transactions, timeouts, guarded writes, poller gating).
5. **A13/A14** (migrations on deploy; gate destructive migrations).
6. **A15/A16/A17** (AI consent, sanctions screening, KYC).
7. **A12 + QA gaps** (adapter-level tests, command dispatch tests).
8. Remaining Important items.

> Findings are from automated specialist review of the real code; each cites `file:line` for verification. Some may be false positives — verify before acting.
