#!/usr/bin/env bash
#
# Provision and start coop-whatsapp on a fresh Ubuntu VM. Oracle Cloud's
# "Always Free" ARM (Ampere A1) instance works well and costs nothing.
# Idempotent — safe to re-run, e.g. after `git pull` on the server.
#
#   sudo bash deploy/bootstrap.sh
#
# It installs Docker, opens the firewall for 80/443, clones/updates the repo
# into APP_DIR, generates the infrastructure secrets in .env, then builds and
# starts the stack. Fill in the provider secrets + DOMAIN afterwards and
# re-run `docker compose up -d`.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/adebestas/coop-whatsapp.git}"
APP_DIR="${APP_DIR:-/opt/coop-whatsapp}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root:  sudo bash deploy/bootstrap.sh" >&2
  exit 1
fi

# ---- 1. Base packages --------------------------------------------------------
export NEEDRESTART_MODE=a DEBIAN_FRONTEND=noninteractive
log "Installing base packages"
apt-get update -y
apt-get install -y ca-certificates curl git openssl cron

# ---- 2. Docker ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker Engine + Compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  log "Docker already installed"
fi

# ---- 3. Firewall -------------------------------------------------------------
# Oracle's Ubuntu images ship a restrictive iptables that REJECTs inbound
# traffic. Open 80/443 here; the VCN Security List ingress rules (tcp 80/443)
# must also be added in the Oracle console.
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null ||
    iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
done
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save || true
fi

# ---- 4. Application checkout -------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  log "Updating $APP_DIR"
  git -C "$APP_DIR" fetch --all --prune
  git -C "$APP_DIR" pull --ff-only
else
  log "Cloning into $APP_DIR"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

# ---- 5. Generate infrastructure secrets once ---------------------------------
if [ ! -f .env ]; then
  log "Creating .env from deploy/.env.example"
  cp deploy/.env.example .env
fi

# gen KEY — replace KEY=<empty> with a random value (never overwrites a set value)
gen() {
  local key="$1" val
  if grep -q "^${key}=$" .env; then
    val="$(openssl rand -hex 24)"
    sed -i "s|^${key}=.*|${key}=${val}|" .env
    log "Generated $key"
  fi
}
gen POSTGRES_PASSWORD
gen REDIS_PASSWORD
gen SESSION_SECRET
gen ADMIN_JWT_SECRET
gen COOP_APP_PASSWORD

# The .env holds every secret in this stack; root-only, always.
chmod 600 .env

# ---- 6. Non-owner app role (RLS enforcement) ---------------------------------
# The app must NOT connect as the table owner: Postgres skips RLS for owners.
# DATABASE_URL (compose) uses coop_app; DATABASE_OWNER_URL is used only by the
# boot-time migration. Idempotent, and re-grants new tables on every run.
read_env() {
  local key="$1" fallback="$2" value
  value="$(grep -E "^${key}=" .env | head -n1 | cut -d= -f2- || true)"
  printf '%s' "${value:-$fallback}"
}
PG_USER="$(read_env POSTGRES_USER coop)"
PG_DB="$(read_env POSTGRES_DB coop)"
APP_PASSWORD="$(read_env COOP_APP_PASSWORD '')"
if [ -z "$APP_PASSWORD" ]; then
  echo "COOP_APP_PASSWORD is empty in .env — refusing to continue" >&2
  exit 1
fi

log "Starting Postgres to provision the app role"
docker compose up -d postgres
for _ in $(seq 1 30); do
  docker compose exec -T postgres pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 && break
  sleep 2
done

log "Provisioning coop_app (non-owner) + grants for RLS"
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" <<SQL
DO \$do\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'coop_app') THEN
    CREATE ROLE coop_app LOGIN PASSWORD '${APP_PASSWORD}';
  ELSE
    ALTER ROLE coop_app LOGIN PASSWORD '${APP_PASSWORD}';
  END IF;
END
\$do\$;
GRANT CONNECT ON DATABASE "${PG_DB}" TO coop_app;
CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA public, app TO coop_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO coop_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO coop_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO coop_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ${PG_USER} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO coop_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ${PG_USER} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO coop_app;
SQL

# ---- 7. Build & start --------------------------------------------------------
log "Building and starting the stack"
docker compose up -d --build

# ---- 8. Nightly backups + uptime watchdog -------------------------------------
log "Installing nightly database backup"
install -m 0755 deploy/backup.sh /usr/local/bin/coop-backup.sh
install -d -m 700 /var/backups/coop-whatsapp
cat >/etc/cron.d/coop-whatsapp-backup <<CRON
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 2 * * * root APP_DIR=$APP_DIR /usr/local/bin/coop-backup.sh >> /var/log/coop-backup.log 2>&1
CRON
chmod 600 /etc/cron.d/coop-whatsapp-backup

log "Installing uptime watchdog"
install -m 0755 deploy/smoke.sh /usr/local/bin/coop-smoke.sh
install -m 0755 deploy/uptime-check.sh /usr/local/bin/coop-uptime.sh
install -d -m 755 /var/lib
cat >/etc/cron.d/coop-whatsapp-uptime <<CRON
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/5 * * * * root APP_DIR=$APP_DIR /usr/local/bin/coop-uptime.sh >/dev/null 2>&1
CRON
chmod 600 /etc/cron.d/coop-whatsapp-uptime

log "Stack status:"
docker compose ps

cat <<'EOF'

Next steps:
  1. Edit .env — set DOMAIN and the WhatsApp / Monnify / Paystack values.
     (The app exits until the FATAL WhatsApp values are present; Caddy/TLS can
      come up first — set DOMAIN and point its A record here.)
     Also set PLATFORM_OWNER_PHONE for the first platform-console login.
  2. Re-run:                 docker compose up -d
  3. Platform console PIN:   docker compose exec app cat platform-owner-pin.txt
                             (change it at https://<DOMAIN>/dashboard/dev/, enable
                              2FA, then delete the file)
  4. WhatsApp webhook URL:   https://<DOMAIN>/webhook
     Verify token:            the WHATSAPP_VERIFY_TOKEN value in .env
  5. Tail logs:              docker compose logs -f app
  6. Smoke test:             sudo bash deploy/smoke.sh   (or: coop-smoke.sh)
  7. Backups:                nightly at 02:15 to /var/backups/coop-whatsapp
                             (14 kept; restore steps in DEPLOY.md)
  8. Uptime alerts:          set ALERT_TELEGRAM_CHAT_ID in .env to get a
                             Telegram message when /health goes down (checks
                             every 5 minutes, alerts on state changes only)
EOF
