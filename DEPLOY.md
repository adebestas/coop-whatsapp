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
   Build passes, then the **pre-deploy command** (`node scripts/db-migrate.mjs`,
   configured as `preDeployCommand` in `render.yaml`) syncs the schema *before*
   the new version receives traffic, and the bot boots after env validation.
   A pre-deploy failure aborts the deploy, so a schema-changing release can
   never boot against the old schema.

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

## Platform Console (Developer Dashboard)

The platform console is the cross-cooperative control plane for platform staff.

1. **Bootstrap the first owner.** Set `PLATFORM_OWNER_PHONE` (E.164, no `+`) —
   and optionally `PLATFORM_OWNER_NAME` — in the service environment
   (`deploy/.env` or the Render dashboard), then (re)start the app. On boot it
   seeds exactly **one** owner with a random 6-digit temp PIN and logs it
   **once**:

   ```
   [platform-bootstrap] Platform owner created for <phone>. Temp PIN: 123456 — change on first login …
   ```

   Capture that PIN from the boot logs immediately. It is never stored in
   plaintext and never logged again. Leave the var unset to skip bootstrapping
   (e.g. once the owner already exists).

2. **First login.** Open `https://<DOMAIN>/dashboard/dev/` and sign in with the
   owner phone + the temp PIN. Because `mustChangePin` is set, you are confined
   to the change-pin flow — set a permanent PIN.

3. **Enable 2FA.** Immediately after changing the PIN, enroll TOTP 2FA on the
   owner account before doing anything else.

A DB failure during bootstrap is logged but does not block startup; retry by
restarting once the database is reachable.

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
- **Migrations**: `scripts/db-migrate.mjs` runs as the service's **pre-deploy
  command** (`preDeployCommand` in `render.yaml`) — once per deploy, before the
  new version gets traffic. It runs `prisma migrate deploy` with safe baselining
  for the db-push-era production database. A failure aborts the deploy.
  Versioned migrations in `prisma/migrations/` give you a rollback path.
  `prisma db push` is **not used in production** — it bypasses migration history.

---

## RLS Enforcement (required before production)

Tenant isolation is enforced by PostgreSQL Row-Level Security, but **only when the
app connects as a non-owner role**. The table owner bypasses every policy, so if
`DATABASE_URL` is the owner connection, `withCoopContext` is a no-op for
isolation. The app now **refuses to boot in production** when RLS is not enforced.

One-time setup (run as the owner/superuser against the production database):

```bash
# 1. Provision the non-owner role (edit the password first; never commit it).
psql "$DATABASE_OWNER_URL" -f prisma/rls/provision_app_role.sql

# 2. Point the app at the non-owner role and keep the owner for migrations/backup:
#    DATABASE_URL       = postgresql://coop_app:<password>@<host>/<db>
#    DATABASE_OWNER_URL = postgresql://<owner>:<password>@<host>/<db>
```

Then redeploy. On boot the app logs `RLS enforced for the current role`; if it
logs the "NOT enforced" error it exits — fix the URLs/role and redeploy.

> The `Federation*` tables are deliberately platform-level (no RLS) — the
> federation is a cross-tenant entity by design. Every other `cooperativeId`
> table has a policy (asserted by `tests/rls-isolation.test.ts`).

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

## Alternative: Oracle Cloud Always Free (self-hosted, $0/month)

If you have no hosting budget, the whole stack (app + PostgreSQL + Redis + Caddy
TLS) runs on a single **Oracle Cloud "Always Free"** ARM VM. Everything ships in
this repo: `docker-compose.yml`, `deploy/Caddyfile`, `deploy/.env.example`,
`deploy/bootstrap.sh`, and `deploy/cloud-init.yaml`.

### 1. Create the VM

In the Oracle Cloud console: **Compute → Instances → Create instance**

- **Image:** Ubuntu 22.04 or 24.04
- **Shape:** `VM.Standard.A1.Flex` (Ampere ARM) — up to 4 OCPU / 24 GB stays in
  the Always Free tier (1 OCPU / 6 GB is plenty to start).
- **Networking:** assign a **public IPv4 address**.
- **SSH keys:** upload yours or let Oracle generate one.
- **Advanced options → Management → Cloud-init script:** paste the contents of
  `deploy/cloud-init.yaml`. It clones the repo to `/opt/coop-whatsapp` and runs
  `deploy/bootstrap.sh` (installs Docker, opens the firewall, generates infra
  secrets, builds and starts the stack).

> Prefer doing it by hand? Create the VM with no cloud-init, then:
> ```bash
> sudo apt-get update && sudo apt-get install -y git
> sudo git clone https://github.com/adebestas/coop-whatsapp.git /opt/coop-whatsapp
> sudo bash /opt/coop-whatsapp/deploy/bootstrap.sh
> ```

### 2. Open ports 80/443 in the Oracle console

`bootstrap.sh` opens the ports inside the VM, but Oracle also filters traffic in
the **VCN Security List** (a console-only step):

**Networking → Virtual Cloud Networks → your VCN → Security Lists → Default →
Add Ingress Rules** — add TCP **80** and **443**, source `0.0.0.0/0`.

### 3. A free hostname (DuckDNS)

Caddy needs a real hostname to obtain a Let's Encrypt certificate. A free
[DuckDNS](https://www.duckdns.org) subdomain works:

1. Create a name, e.g. `mycoop.duckdns.org`.
2. Set its **A record** to the VM's public IP address.

### 4. Fill in `.env`

```bash
cd /opt/coop-whatsapp
nano .env
```

- `DOMAIN` — the DuckDNS hostname (e.g. `mycoop.duckdns.org`).
- `WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`,
  `WHATSAPP_VERIFY_TOKEN` — **required**; the app exits at boot without them.
- `MONNIFY_*` / `PAYSTACK_SECRET_KEY` — payment credentials.
- `PLATFORM_OWNER_PHONE` — E.164 number (no `+`) for the first platform-console
  login. The boot seed writes a random temp PIN to `platform-owner-pin.txt`
  (mode 0600, gitignored) instead of logging it.
- `PILOT_FLOAT_CAP` — monthly money-out ceiling in **kobo** (default `500000`
  = ₦5,000). Keep it low (or lower) for a no-money pilot.
- The five infra secrets (`POSTGRES_PASSWORD`, `REDIS_PASSWORD`,
  `SESSION_SECRET`, `ADMIN_JWT_SECRET`, `COOP_APP_PASSWORD`) were already
  generated by `bootstrap.sh`; leave them. The app connects as the non-owner
  `coop_app` role (`DATABASE_URL`), while migrations use `DATABASE_OWNER_URL` —
  that split is what makes Postgres RLS effective in production.

### 5. Start / update

```bash
cd /opt/coop-whatsapp
docker compose up -d --build      # start (or apply .env changes)
docker compose logs -f app        # tail logs
docker compose ps                 # container status
curl -fsS https://$DOMAIN/health  # health check
```

To deploy new code:

```bash
sudo git -C /opt/coop-whatsapp pull
cd /opt/coop-whatsapp && sudo docker compose up -d --build
```

### 6. Register the WhatsApp webhook

Point the WhatsApp Cloud API webhook at:

```
https://<DOMAIN>/webhook
```

with the verify token set to `WHATSAPP_VERIFY_TOKEN`. See Step 3 above for the
provider-specific webhook fields.

### Notes

- **No staging/production split:** this is a single self-hosted instance. The
  `render.yaml` blueprint and CI deploy gates still work for Render if you move
  back to it later.
- **Backups:** installed by `bootstrap.sh` — nightly at 02:15 to
  `/var/backups/coop-whatsapp` (custom-format dumps, 14 kept). See below.
- **ARM:** all images (`node:22-alpine`, `postgres:16-alpine`, `redis:7-alpine`,
  `caddy:2-alpine`) are multi-arch, so the Ampere VM needs no changes.
- **TLS:** Caddy auto-renews certificates; data lives in the `caddy_data`
  volume, so keep it.

### 7. Verify & monitor

```bash
cd /opt/coop-whatsapp
sudo bash deploy/smoke.sh            # TLS, /health (DB+Redis), dashboard, webhook
```

The smoke script also prints a manual checklist (join, wallet, savings, loan,
repay, withdrawal, duplicate webhook, OTP lockout, console first login) — run it
before inviting members.

First console login (only appears once, on first boot):

1. Read the temp PIN: `docker compose exec app cat platform-owner-pin.txt`
2. Log in at `https://<DOMAIN>/dashboard/dev/`, change the PIN.
3. Enrol 2FA (`POST /api/developer/setup-2fa` from the dashboard UI), then
   delete `platform-owner-pin.txt` inside the container and on the host.
4. Confirm the PIN never appears in `docker compose logs app`.

Uptime watchdog: `/etc/cron.d/coop-whatsapp-uptime` checks `https://<DOMAIN>/health`
every 5 minutes. Set `ALERT_TELEGRAM_CHAT_ID` in `.env` to receive a Telegram
message on down/degraded/recovered transitions (state changes only).

### 8. Backups & restore

Backups run from `/etc/cron.d/coop-whatsapp-backup` via
`/usr/local/bin/coop-backup.sh` (source: `deploy/backup.sh`).

```bash
sudo /usr/local/bin/coop-backup.sh     # take one now
ls -lh /var/backups/coop-whatsapp      # coop-YYYY-MM-DD.dump
```

**Test a restore monthly** (into a scratch DB, never the live one):

```bash
cd /opt/coop-whatsapp
docker compose exec -T postgres createdb -U coop coop_restore
docker compose exec -T postgres pg_restore -U coop -d coop_restore --no-owner \
  < /var/backups/coop-whatsapp/coop-2026-10-25.dump
docker compose exec -T postgres psql -U coop -d coop_restore -c "select count(*) from \"Member\";"
docker compose exec -T postgres dropdb -U coop coop_restore
```

**Restore in place** (only after stopping the app so writes cannot race):

```bash
cd /opt/coop-whatsapp
docker compose stop app
docker compose exec -T postgres pg_restore -U coop -d coop --clean --if-exists --no-owner \
  < /var/backups/coop-whatsapp/coop-2026-10-25.dump
docker compose start app && docker compose logs -f app
```

Copy dumps off the VM (e.g. `scp`) if the data matters — a backup on the same
disk does not survive disk loss.