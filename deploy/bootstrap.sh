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
apt-get install -y ca-certificates curl git openssl

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

# ---- 6. Build & start --------------------------------------------------------
log "Building and starting the stack"
docker compose up -d --build

log "Stack status:"
docker compose ps

cat <<'EOF'

Next steps:
  1. Edit .env — set DOMAIN and the WhatsApp / Monnify / Paystack values.
     (The app exits until the FATAL WhatsApp values are present; Caddy/TLS can
      come up first — set DOMAIN and point its A record here.)
  2. Re-run:                 docker compose up -d
  3. WhatsApp webhook URL:   https://<DOMAIN>/webhook
     Verify token:            the WHATSAPP_VERIFY_TOKEN value in .env
  4. Tail logs:              docker compose logs -f app
EOF
