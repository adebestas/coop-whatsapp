# Expert Review — coop-whatsapp

Date: 2026-10-03 · Reviewer: engineering / security / fintech / ops
Scope: architecture, security, compliance, reliability, product. Read-only
assessment; no code changed by this review.

This is a genuinely well-built system. The security model (dual control,
idempotency keys, atomic claims, webhook signature verification, hash-chained
audit) is better than most production fintech code I see. The items below are
what I would fix to take it from "impressive prototype" to "safe to run real
money at scale", ordered by what can hurt you most.

---

## Executive summary

| # | Item | Tier | Effort | Why it matters |
|---|------|------|--------|----------------|
| 1 | Regulatory posture (CBN / NDPR / AML) | 0 | High (external) | Existential; longest lead time |
| 2 | RLS enabled but not enforced | 0 | Medium | False sense of tenant isolation |
| 3 | Transaction held during network I/O | 1 | Medium | Connection-pool exhaustion |
| 4 | Scheduler runs in the web process | 1 | Medium | Silently skipped jobs |
| 5 | Single-instance in-memory state | 1 | Medium | Blocks horizontal scale |
| 6 | Observability / alerting | 1 | Low–Medium | Blind to money incidents |
| 7 | Ambiguous-phone lockout | 2 | Low | Real member lockout |
| 8 | Audit hash-chain race | 2 | Low | Forked audit chain |
| 9 | Admin token lifetime | 2 | Low | Session-hijack blast radius |
| 10 | Secrets rotation / vault | 2 | Low | Credential exposure |
| 11 | Stale security docs | 2 | Low | Misleads the next reviewer |
| 12 | AI as operating system, not chat | 3 | High | The actual differentiator |
| 13 | Command surface (30+) | 3 | Medium | Onboarding friction |
| 14 | RLS test suite can't pass | 3 | Low | Isolation untested in CI |

---

## Tier 0 — existential

### 1. Regulatory posture (CBN / NDPR / AML)

The platform holds members' savings and moves money on their behalf. In Nigeria
that touches:

- **CBN licensing** — deposit-taking and payment services are regulated. A
  cooperative may operate under a partner-bank / trust arrangement rather than
  a full licence, but that structure must be deliberate and documented.
- **NDPR** — the consent gate (`consentAt`) and `DataConsent` model are a good
  start; you still need a privacy policy, data-subject request handling, and a
  lawful basis for processing.
- **AML/CFT** — the `STR` model and `PAYERecord` exist; you need a documented
  AML programme, transaction monitoring thresholds, and a reporting path.

`AUDIT.md` lists these as open gaps. This is not an engineering problem and it
has the longest lead time. **Engage a Nigerian fintech lawyer and a compliance
officer now, in parallel with development.** Everything else is secondary to
not being shut down.

### 2. RLS is enabled but not enforced

`prisma/migrations/20261005000000_rls_policies` ENABLEs RLS on 50 tenant
tables, but the app connects as the **table owner**, which bypasses the
policies. So today RLS is a no-op — it *looks* protected but isn't.

This is a dangerous middle state. Two acceptable end states:

- **Finish the cutover:** non-owner app role, `FORCE ROW LEVEL SECURITY`, every
  entry point routed through `withCoopContext`, and a Postgres CI run with
  `RLS_ENABLED=1`. (In progress — see `prisma/rls/README.md`.)
- **Or label it loudly** as "not yet enforced" everywhere it is mentioned, so
  nobody assumes isolation they don't have.

Do not ship the middle state silently.

---

## Tier 1 — architecture

### 3. Transaction held during network I/O

`withCoopContext` wraps the entire chat handler, including the WhatsApp/Telegram
sends. A Prisma interactive transaction pins one pooled connection for its whole
duration, so a slow provider call holds a connection. Under load this exhausts
the pool (`connection_limit=10`).

Options, in order of preference:

1. Scope the transaction to the DB work only — do the reads/writes in a
   transaction, then send messages after it commits.
2. Use a request-scoped connection with a **session** GUC (PgBouncer session
   mode) instead of a transaction-local GUC.

This is the main cost of the current RLS design and should be measured before
Stage 2 goes live.

### 4. Scheduler runs inside the web process

Backups, daily digest, status poller, proactive alerts, statements and birthday
greetings all run in-process (`src/services/scheduler.ts`). A restart, a deploy,
or a busy event loop silently skips jobs — and a missed digest or poller is a
money-safety gap, not a cosmetic one.

Move scheduled work to a durable queue/worker (BullMQ + Redis, already
provisioned in `render.yaml`) with a distributed lock so exactly one worker runs
each job.

### 5. Single-instance in-memory state

Rate limits, webhook dedupe maps, and scheduler "last run" guards are in-memory
(`DEPLOY.md` notes this). Fine for a pilot; a hard blocker for scale. Move them
to Redis. The webhook dedupe is already DB-backed (`WebhookEvent`) — good — but
the rate limiters are not.

### 6. Observability / alerting

There is no error tracking or log drain mentioned. For a system that moves
money, you need:

- Error tracking (Sentry or equivalent) with release tagging.
- Structured logs shipped off-box.
- Alerts on: rows stuck in `processing` > threshold, reconciliation drift,
  webhook signature failures, provider circuit-breaker trips, and **fail-closed
  (zero-row) tenant queries** once RLS is enforced.

The hash-chained audit + nightly reconciliation is excellent — surface its
output on a dashboard rather than only in logs.

---

## Tier 2 — correctness & security

### 7. Ambiguous-phone lockout

A phone registered in 2+ cooperatives resolves to `null` everywhere
(`getMemberByPhone` fails closed), so the person is treated as an unregistered
guest for every command. They are never shown another coop's data (good), but
there is no coop-selection flow, so a genuinely double-registered member is
locked out. This is a symptom of the global `Session` table being keyed by
phone. Add a coop-selection step or per-coop sessions.

### 8. Audit hash-chain race

Concurrent audit writes can read the same "previous hash" and fork the chain.
Serialize the writer (Postgres advisory lock, or a single-writer queue).

### 9. Admin token lifetime

Admin dashboard tokens are 8-hour bearer tokens (`TOKEN_TTL_MS`). Consider
shorter access tokens + refresh, and bind to device/IP where feasible, to shrink
the blast radius of a stolen token.

### 10. Secrets rotation / vault

Rotate any previously-exposed tokens (see project memory: a Gemini key and a
GitHub OAuth token were exposed in transcripts). Consider a secrets vault for
provider keys rather than plain Render env vars.

### 11. Stale security docs

`AUDIT.md` claims "floats for money" — the schema actually stores money as
integer kobo (`Int`). Stale security documentation is worse than none: it
misleads the next reviewer. Reconcile `AUDIT.md` with the current schema.

---

## Tier 3 — product / the "AI cooperative"

### 12. The AI is a chat assistant today, not an operating system

The AI layer is well-built and safely scoped (never auto-executes, read-only,
PII-guarded, prompt-injection hardened). But to earn the "AI cooperative" label
it should do operational work:

- **Admin ops:** fraud/anomaly scoring on transactions, reconciliation triage,
  unusual-approval-pattern detection.
- **Member coaching:** `getFinancialMemory` is a strong seed — extend it into
  proactive, personalised savings/borrowing guidance.
- **Support triage:** classify and route tickets, draft resolutions.

Keep AI strictly **advisory** on money movement. The current design already does
this; do not drift.

### 13. Command surface (30+ commands)

The AI fallback and `contexthelp` help, but a 30+ command menu is onboarding
friction. Add progressive disclosure / a guided menu, and let the AI surface the
right command for the member's intent.

### 14. RLS test suite can't pass as written

`tests/rls-isolation.test.ts` uses session-scoped `set_config(..., false)` on a
pooled client and connects as the owner, so even with `RLS_ENABLED=1` the
isolation assertions would fail (owner bypass). Add a **non-owner** Prisma
client for the suite so the isolation tests actually run in CI. Also keep the
SQLite-in-tests vs Postgres-in-prod drift guarded by the existing schema-sync
tests.

---

## What I'd do next, concretely

1. **Finish the RLS cutover** on its own branch: non-owner role, FORCE, Postgres
   CI run, and a fail-closed canary that logs when a tenant query unexpectedly
   returns zero rows.
2. **Start the legal/compliance review in parallel** — it gates everything and
   has the longest lead time.
3. **Extract the scheduler to a durable worker** — the next-biggest reliability
   risk after RLS.
4. **Add observability** (error tracking + the money-safety alerts above).
5. **Then** invest in the AI-as-operating-system work, which is the real
   differentiator.

---

## Verified facts (so this review doesn't repeat stale claims)

- Money is stored as **integer kobo** (`Int`) across the schema — not floats.
  `AUDIT.md`'s "floats for money" note is stale.
- Webhook dedupe is **DB-backed** (`WebhookEvent`), not in-memory — good.
- RLS policies exist on **50 tables** (36 direct `cooperativeId`, 13 via a
  parent, plus `Cooperative`), verified against a fresh Postgres 16.
- The app currently connects as the **table owner**, so RLS is not enforced.
