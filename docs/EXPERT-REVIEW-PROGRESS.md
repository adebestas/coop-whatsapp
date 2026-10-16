# Expert-Review Remediation — Progress & Resume

**Branch:** `feat/world-class` · **HEAD:** `9c384a1` · **Base for this work:** `f52dda3`
**Full findings:** `docs/EXPERT-REVIEW-2026-10-15.md`
**Method:** fix one finding at a time — verify the finding, ask the user about the fix + test, implement (TDD), run the focused tests + `tsc` + `eslint src/` + `prettier`, commit.

## Done (committed)

| # | Finding | Commit |
|---|---------|--------|
| A1 | WhatsApp webhook verified with the App Secret (not the access token); fail-closed in prod, dev bypass | `633afb1` |
| A2 | Production refuses to boot when RLS isn't enforced | `1bb1404` |
| A3 | RLS policies for the 5 missed `cooperativeId` tables + 5 child tables; CI test asserts coverage | `1bb1404` |
| A4 | Members resolved within the active cooperative (`getCoopId()`), not by phone alone | `93e2622` |
| A5 | Loan `balance` = outstanding principal (loans close; no overpay) + migration | `722c6fd` |
| A6 | `recordLedger` books the true counter-leg (not always `assets:bank`) | `8bfb404` |
| A7 | Dividend base = current period's profit (no re-distribution) | `2e20c39` |
| A8 | Mandate provider calls run outside the transaction (two-phase) | `87f5229` |
| A9 | 15s timeout on Monnify/Paystack/Flutterwave HTTP calls | `3058281` |
| A10 | Guarded atomic loan-balance decrement in deductions | `9a3bb71` |
| A11 | `runTransferPolling` gates booking on the guarded update count; per-row try/catch; pay-anyone reuses an existing payout instead of P2002 | `ea15f3a` |
| A12 | Adapter-level tests: `payout`/`createVirtualAccount`/`resolveAccount` for Monnify, Paystack, Flutterwave (fetch stubbed) | `5c00d1d` |
| A13 | Migrations wired as a Render `preDeployCommand` on both web services (native Node); Docker comments/DEPLOY.md corrected; `tests/deploy-config.test.ts` guards it | `b763eb9` |
| A14 | `20261002000000` now archives `Member.tier` / `LedgerEntry.status` to `_backup_*` tables and renames (quarantines) instead of dropping when populated; `tests/migrations-destructive.test.ts` bans bare `DROP COLUMN`/`DROP TABLE` | `af7ad9f` |
| A15 | AI-processing consent: `Member.aiConsentAt` (migration `20261052000000`), `ai_processing` DataConsent, lazy consent prompt (`awaiting_ai_consent`, `aioptin`/`aioptout`); webhook no longer transcribes — `handleMessage` resolves member+consent then transcribes/translates only when granted | `ebfe371` |
| A16 | Sanctions/PEP screening: `SanctionsEntry` (platform watchlist) + `ScreeningResult` (tenant, RLS) + `Member.screeningStatus` (migration `20261053000000`); `services/screening.ts` (local fuzzy match + external `SANCTIONS_SCREENING_URL` hook, fail-closed); gates member/NOK onboarding (flag+alert), payee add, and the payout choke point (disbursements + payanyone block money-out on match) | `0b8204e` |
| A17 | NIN-based KYC (BVN deliberately not collected): `Member.nin`/`kycStatus`/`kycVerifiedAt` (migration `20261054000000`); `services/kyc.ts` (`verify <NIN>`, external `NIN_VERIFY_URL` hook + name match, `pending` fallback, `confirmkyc` super-admin manual approval); tier limits derive from KYC (verified → tier 2) so withdrawals/loans above the low ceiling need a verified NIN; BVN copy removed | `3de184b` |

## All Critical findings (A1–A17) addressed

Continue with the **Important** list in `docs/EXPERT-REVIEW-2026-10-15.md` §B (also summarised below) and the Minor list.

## Remaining — Important (from `docs/EXPERT-REVIEW-2026-10-15.md` §B)

Insurance booked as coop P&L though the coop is only an agent; insurance charges not idempotent + post-charge DB failure leaks the premium; claim payout can exceed approval; federation interest ignores repayment timing; P2002-catch idempotency inside a shared tx is unsafe on Postgres (`topup.ts:150-200`); `RedisMutex` can't guarantee single-processing; withdrawal guard documented but not implemented; nested `withCoopContext` overwrites the RLS GUC; `flutterwave.ts` has zero tests; several money commands untested through `handleMessage`; scheduler job bodies untested; Redis-path untested; `InsuranceService` beyond purchasePlan/handleWebhook untested; hand-maintained `beforeEach` table lists drifted; admin dashboard path hardcoded to `/app/dashboard`; backups truncated/ephemeral/unverified; `uncaughtException` non-fatal; graceful shutdown never completes; queue retries misconfigured; CI deploy gates cosmetic; DB connection budget; AML reports mislabeled (STR vs CTR) + wrong amount; AML doesn't block/delay; data-retention job dead code; right-to-erasure incomplete; consent records semantically wrong.

### Important — done so far

- **Insurance finance + IDOR** (`636dbab`): premiums/claims now book to an agent liability account `liabilities:insurance_payable` (not coop P&L); `chargePremium` is idempotent on its ref and the premium is refunded if `insurancePolicy.create` fails after a successful provider purchase; claim payout is capped at `min(payoutKobo ?? amountKobo, amountKobo)` and rejected claims are never paid; `approveInsuranceClaim`/`rejectInsuranceClaim`/`listMemberInsuranceClaims` are now scoped by `cooperativeId`.
- **Federation loan interest** (`e6a650e`): interest now accrues over the actual outstanding period (capped at the term — early repayment costs less), and the final interest charge is non-reverting: it charges at most the coop's available fund and records any shortfall as still owed (audited), so a full principal repayment can never roll back.
- **Topup webhook idempotency** (`ff77f2c`): replaced the in-transaction `throwOnDuplicate`/P2002-catch (unsafe on Postgres — the violation aborts the tx) with a read-first `journalEntry` check; a duplicate is a clean no-op and no side effects run. The `txRef` unique constraint stays as the backstop for a true concurrent race, whose losing tx (aborted → rolled back) is caught at the outer boundary as a no-op.

## Vibe-coding hardening track (security / perf / ops)

Deep-research hardening pass (Replit DB deletion, Lovable PII, Vercel env leakage, etc.). Starting point for this track: `ff77f2c`.

| # | Finding | Commit |
|---|---------|--------|
| SEC-1 | Withdrawal guard: row lock (`SELECT … FOR UPDATE` on Postgres) + one-open-request per member | `65d3dfd` |
| SEC-2 | RLS GUC no longer overwritten by nested `withCoopContext`; new `withCoopGuc` restores the prior value on exit | `3fbe70a` |
| SEC-3 | AI hardening: `requireAiConsent` gates the 4 NL→Groq paths; member/admin command sets split; `suggestCommand` is member-only | `0315250` |
| SEC-4 | Export scoping: coop-scoped filenames; route requires exact coop-prefix match | `a6c1ca0` |
| SEC-5 | Money printer: test-only `createContribution` moved out of `src/services/cooperative.ts` into `tests/test-money.ts` | `2818135` |
| SEC-6 | Secrets hygiene: scrubbed `.env`, hashed translation-cache key, redacted rate-limit key log, secret scan test | `93a6fa1` |
| SEC-7 | Supply chain: Dependabot, CI prod-audit job, SHA-pinned actions, CI-hardening test | `a75d15a` |
| SEC-8 | Device binding: `validateDeviceSession` is advisory-only (IP dropped) | `a0c0b4d` |
| SEC-9 | `RedisMutex` single-processing: unique owner token + atomic compare-and-delete release + TTL heartbeat | `8189bc8` |
| PERF-1 | DB connection budget: every pool bounded (app `DB_CONNECTION_LIMIT`, owner `DB_OWNER_CONNECTION_LIMIT`) + configurable | `5385656` |
| PERF-2 | Backups: complete (PK pagination, no silent 50k truncation) + fail-closed in prod without off-instance storage (`BACKUP_ALLOW_LOCAL=1`) + `verifyBackupFile()` validates the artifact. Also repaired 5 scheduler jobs that passed a fn as `logAndAlert`'s error → never ran. | `ed364ce` |
| PERF-3 | Hot-path indexes: `Member.virtualAccountNumber` (top-up webhook/resolver), `Payout.(memberId, createdAt)` (statements/AML), `Posting.entryId` (journal reads). Migration `20261055000000_hot_path_indexes`. | `73489df` |
| PERF-4 | AI spend capped: voice-transcription + translation paths now enforce the per-member AI budget before calling Groq; `checkAIRateLimit` Redis TTL now set only on first increment (window actually closes); limit/window configurable (`AI_MAX_PER_HOUR`, `AI_WINDOW_SECONDS`). | `ddb1911` |
| OPS-1 | Crash/shutdown reliability: new `createShutdown` (`src/lib/shutdown.ts`) runs each close step, continues past failures (exit 1), idempotent, 15s watchdog force-exit; `uncaughtException` now fatal; in-process scheduler loops stop on shutdown; Fastify `forceCloseConnections: true`. | `3a9898b` |
| OPS-2 | Queue retries: removed invalid Worker option `maxStartedAttempts` (not a BullMQ option → jobs never retried); added `DEFAULT_JOB_OPTIONS` (`attempts: 3` + exponential backoff) applied to scheduler jobs. | `b73ccd2` |
| OPS-3 | AML reports labelled correctly: new `STR.reportType` ("STR"/"CTR") + migration `20261056000000_str_report_type`; pattern hits → STR, threshold crossings → CTR; CBN payload/notifications now carry the true `reportedAmount` (aggregate total), not the single-tx amount; type surfaced in admin listing, compliance export and regulator report. | `c5fc230` |
| OPS-4 | AML blocks: `finalizeWithdrawal` checks AML *before* debit/payout; a suspicious pattern (STR) sets the request to `aml_review` and moves no money, requiring `finalize <id> override` (audited) to release. CTR-only large withdrawals are reported but still pay. | `9c384a1` |

**All SEC-1…9 and PERF-1…4 done; OPS-1…4 done.** Next: the remaining OPS items (retention/erasure, dashboard route, CI deploy gate).

> **Rotate the Neon credential** scrubbed from `.env` in SEC-6 — still live in Neon until rotated there.


## Remaining — Minor

AI prompt still says ₦ (`ai-query.ts:153`); translation trigger ignores the resolved locale; `+1` → US-only; `admin.ts`↔`conversation.ts` cycle (LOCALES); test-only money printer exported (`cooperative.ts:299-370`); device-binding hard-block; altChannelId unscoped; a live Neon credential in a commented `.env` line; `trustProxy: true`; audit chain tamper-evident not tamper-proof; PII in the translation cache; full PII in exports.

## Resume

1. `cd C:\Users\Hp\projects\coop-whatsapp` · `git log --oneline -1` (expect `9c384a1`).
2. Read this file + `docs/EXPERT-REVIEW-2026-10-15.md` + `~/.config/opencode/memory.md`.
3. All **Critical (A1–A17)**, the insurance + federation + topup Important items, **SEC-1…9**, **PERF-1…4** and **OPS-1…4** are done. Next: the remaining **OPS items** — same loop (verify → ask about fix+test → implement → test → commit).

> **A15 follow-up:** voice + translation are now consent-gated, but the natural-language
> AI paths (`suggestCommand` in `lib/ai.ts`, `ai-query.ts`, `ai-insights.ts`) still send
> member text to Groq without the `ai_processing` gate. Gate them the same way (reuse
> `getAiConsentState`) when those findings come up in the Important list.

> **A14 caveat:** editing `20261002000000_loan_stages_account_officers/migration.sql`
> changes its Prisma checksum. Safe because prod isn't deployed and dev uses
> `db push`; but if any environment already has that migration recorded,
> `migrate deploy` will fail with a checksum mismatch and needs
> `prisma migrate resolve --applied 20261002000000_loan_stages_account_officers`.

## Also pending (separate)

- **PR not created** — `gh` isn't authenticated. Run `gh auth login`, then:
  `gh pr create --base main --head feat/world-class --title "feat: multi-language + multi-currency, CubeCover insurance hardening, and federation" --body-file PR_BODY.md`
- Untracked (not committed): `PR_BODY.md`, `docs/EXPERT-REVIEW-2026-10-15.md`, `docs/superpowers/plans/2026-10-14-multi-language-multi-currency.md`, `docs/superpowers/plans/2026-10-15-federation.md`, `docs/superpowers/specs/2026-10-14-multi-language-multi-currency-design.md`.
- **Not yet deployed** — see the pre-launch checklist in the earlier assessment (staging env, RLS cutover, CubeCover docs, prod env vars, `db:migrate:deploy`).
