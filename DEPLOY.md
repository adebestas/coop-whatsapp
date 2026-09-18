# Live Deployment — Render + PostgreSQL + GitHub (Staging + Production)

The bot is a long-running Node service with a PostgreSQL database, deployed
from GitHub. `render.yaml` in this repo is a Render Blueprint: it creates
**two environments** with isolated databases:

| Environment | Branch | Database | Redis | Web Service | Credentials |
|-------------|--------|----------|-------|-------------|-------------|
| **Staging** | `staging` | `coop-db-staging` | `coop-redis-staging` | `coop-bot-staging` | **Sandbox/test** (Monnify sandbox, test WhatsApp) |
| **Production** | `main` | `coop-db` | `coop-redis` | `coop-bot` | **Live** (Monnify prod, real WhatsApp) |

> ⚠️ Use the **Starter** plan for all web services. The free plan sleeps after
> 15 minutes of inactivity — WhatsApp messages and scheduled jobs (digest,
> poller, backups) would silently stop.

---

## Architecture

```
GitHub (staging branch) ──push──▶ Render ──deploy──▶ Staging (coop-bot-staging + coop-db-staging + coop-redis-staging)
                                    │
                                    │ manual approval / merge PR
                                    ▼
GitHub (main branch) ────push────▶ Render ──deploy──▶ Production (coop-bot + coop-db + coop-redis)
```

---

## Step 1 — GitHub Setup

1. Create an **empty private repo** on github.com (e.g. `coop-whatsapp`).
   Do NOT initialize with README.
2. From the project folder:

```bash
git remote add origin https://github.com/<your-username>/coop-whatsapp.git
git push -u origin main
```

3. Create a **staging branch** (one-time setup):

```bash
git checkout -b staging
git push -u origin staging
```

> **Every push to `staging` auto-deploys to the Staging environment.**
> **Every push to `main` auto-deploys to the Production environment.**

---

## Step 2 — Render Blueprint Deploy (First Time Only)

1. Sign up at render.com → Dashboard → **New +** → **Blueprint**.
2. Select the GitHub repo — Render reads `render.yaml` and creates:
   - `coop-db` (PostgreSQL) + `coop-redis` — **Production**
   - `coop-db-staging` (PostgreSQL) + `coop-redis-staging` — **Staging**
   - `coop-bot` (Node web service, health check `/health`) — **Production**
   - `coop-bot-staging` (Node web service, health check `/health`) — **Staging**

3. **First build fails on missing secrets — that's expected.**
   Open each service → **Environment** and fill in variables marked `sync: false`.

### Staging Environment Secrets (use SANDBOX/TEST credentials)

| Service | Variable | Value |
|---------|----------|-------|
| `coop-bot-staging` | `WHATSAPP_TOKEN` | Meta test app token |
| | `WHATSAPP_PHONE_NUMBER_ID` | Meta test phone number ID |
| | `WHATSAPP_VERIFY_TOKEN` | Your test verify token |
| | `TELEGRAM_BOT_TOKEN` | @BotFather test token |
| | `MONNIFY_API_KEY` | Monnify sandbox API key |
| | `MONNIFY_SECRET_KEY` | Monnify sandbox secret |
| | `MONNIFY_CONTRACT_CODE` | Monnify sandbox contract code |
| | `PAYSTACK_SECRET_KEY` | Paystack test secret |
| | `PILOT_FLOAT_CAP` | e.g. `10000000` (₦100k) |

> `MONNIFY_BASE_URL` is already set to `https://sandbox.monnify.com` in the blueprint.
> `ADMIN_JWT_SECRET` and `SESSION_SECRET` are auto-generated.

### Production Environment Secrets (use LIVE credentials)

| Service | Variable | Value |
|---------|----------|-------|
| `coop-bot` | `WHATSAPP_TOKEN` | Meta **production** app token |
| | `WHATSAPP_PHONE_NUMBER_ID` | Meta **production** phone number ID |
| | `WHATSAPP_VERIFY_TOKEN` | Your production verify token |
| | `TELEGRAM_BOT_TOKEN` | @BotFather production token |
| | `MONNIFY_API_KEY` | Monnify **production** API key |
| | `MONNIFY_SECRET_KEY` | Monnify **production** secret |
| | `MONNIFY_CONTRACT_CODE` | Monnify **production** contract code |
| | `PAYSTACK_SECRET_KEY` | Paystack **live** secret |
| | `PILOT_FLOAT_CAP` | Your monthly safety ceiling (kobo) |

> `MONNIFY_BASE_URL` is already set to `https://api.monnify.com` in the blueprint.
> `ADMIN_JWT_SECRET` and `SESSION_SECRET` are auto-generated.

4. **Manual Deploy → Deploy latest commit** for each service.
   Build passes, schema syncs via `prisma migrate deploy` (runs at container startup),
   bot boots after env validation.

---

## Step 3 — Point Provider Webhooks

### Staging Webhooks (point to `coop-bot-staging` URL)

Base URL: `https://<staging-render-service-url>` (shown on the staging service page).

| Provider | Webhook URL | Where to set it |
|---|---|---|
| Meta WhatsApp | `https://…/webhook` | Meta App (test) → WhatsApp → Configuration (+ verify token) |
| Monnify | `https://…/webhooks/payments/monnify` | Monnify sandbox dashboard → Settings → Webhooks |
| Paystack | `https://…/webhooks/payments/paystack` | Paystack dashboard (test) → Settings → API Keys & Webhooks |

### Production Webhooks (point to `coop-bot` URL)

Base URL: `https://<production-render-service-url>` (shown on the production service page).

| Provider | Webhook URL | Where to set it |
|---|---|---|
| Meta WhatsApp | `https://…/webhook` | Meta App (production) → WhatsApp → Configuration (+ verify token) |
| Monnify | `https://…/webhooks/payments/monnify` | Monnify production dashboard → Settings → Webhooks |
| Paystack | `https://…/webhooks/payments/paystack` | Paystack dashboard (live) → Settings → API Keys & Webhooks |

Also IP-allowlist your Render outbound IP in Monnify/Paystack dashboards if
the provider supports it (Render static IPs require a paid add-on).

---

## Step 4 — Promotion Flow: Staging → Production

**Do not push directly to `main`.** All changes go through staging first:

```bash
# 1. Develop on a feature branch
git checkout -b feature/xyz
# ... make changes, test locally ...

# 2. Push to staging for integration testing
git push origin feature:xyz
# Create PR to merge feature/xyz → staging
# After CI passes and manual review, merge to staging
# → Auto-deploys to Staging environment

# 3. Smoke test on Staging (see Step 5 below)
#    Use sandbox/test credentials only!

# 4. Promote to Production
#    Create PR: staging → main
#    After approval, merge to main
#    → Auto-deploys to Production environment
```

> **Never push directly to `main`.** The `main` branch is protected by this workflow.
> If you need a hotfix, create a branch from `main`, fix, then PR to `staging` first,
> then promote `staging` → `main`.

---

## Step 5 — Smoke Test on Staging (Before Promotion)

1. Send "menu" to the bot from WhatsApp (test number) → menu replies.
2. Register a test cooperative + members; every admin runs `enable2fa`.
3. Top up ₦100 via bank transfer to the member's virtual account → wallet
   credits within seconds (webhook path, Monnify sandbox).
4. Super runs `payout 50 <phone> <narration> <totp code>` → money lands in sandbox;
   poller log shows no stuck transfers.
5. Wait for the 20:00 **Daily summary** message; run `backup` and `reconcile` via chat.
6. Verify admin dashboard loads at `https://<staging-url>/dashboard/`.

**Only promote to production after all staging tests pass.**

---

## Local Development

Local development needs a PostgreSQL database. Options:

1. **Neon.tech** (free tier): `DATABASE_URL=postgresql://...` in `.env`
2. **Render External Database URL**: Copy from `coop-db` or `coop-db-staging` dashboard → Connections → External Database URL
3. **Local PostgreSQL**: `DATABASE_URL=postgresql://user:pass@localhost:5432/coop`

```bash
cp .env.example .env
# Edit .env with your DATABASE_URL and other secrets
npm run prisma:generate:local  # uses schema.local.prisma (SQLite) or prisma:generate for Postgres
npm run dev                    # tsx watch src/index.ts
```

> The local schema (`schema.local.prisma`) uses SQLite for zero-config testing.
> For full Postgres parity, use a cloud Postgres URL and `npm run prisma:generate`.

---

## Notes & Limits

- **Backups**: the daily JSON snapshot writes to the service's local disk,
  which resets on redeploys. Your primary safety net is Render's automatic
  Postgres backups (dashboard → coop-db → Backups). Download one occasionally.
  **Staging backups go to a separate bucket/prefix if configured.**
- **Exports**: generated files live on the same ephemeral disk — download them
  promptly, or attach a Render persistent disk / S3 later.
- **Scaling**: one instance only (in-memory rate-limit/dedupe maps assume it).
  See Tier 0 item #3 for horizontal scaling requirements.
- **Migrations**: `prisma migrate deploy` runs at **container startup** (see `Dockerfile` CMD).
  Versioned migrations in `prisma/migrations/` give you a rollback path.
  `prisma db push` is **not used in production** — it bypasses migration history.

---

## Rollback Procedure (Production)

If a bad deploy reaches production:

```bash
# 1. Revert the merge on GitHub (revert the PR that merged staging → main)
# 2. Push the revert to main → auto-deploys previous version
# 3. If schema migration was applied and is incompatible:
#    a. Connect to Render Postgres: psql <External Database URL>
#    b. Manually revert the migration: DELETE FROM _prisma_migrations WHERE migration_name = '...';
#    c. Or restore from Render's automatic Postgres backup (dashboard → coop-db → Backups)
```

> **Always test migrations on staging first.** The staging database is an exact
> structural copy of production, so any migration that works on staging will
> work on production.