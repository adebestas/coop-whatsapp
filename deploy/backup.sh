#!/usr/bin/env bash
#
# Nightly logical backup of the coop-whatsapp Postgres database.
# Installed to /usr/local/bin/coop-backup.sh by deploy/bootstrap.sh and run from
# /etc/cron.d/coop-whatsapp-backup. Keeps 14 daily dumps.
#
#   sudo /usr/local/bin/coop-backup.sh
#
# Restore: see "Backups & restore" in DEPLOY.md.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/coop-whatsapp}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/coop-whatsapp}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

cd "$APP_DIR"

read_env() {
  local key="$1" fallback="$2" value
  value="$(grep -E "^${key}=" .env | head -n1 | cut -d= -f2- || true)"
  printf '%s' "${value:-$fallback}"
}

PG_USER="$(read_env POSTGRES_USER coop)"
PG_DB="$(read_env POSTGRES_DB coop)"

install -d -m 700 "$BACKUP_DIR"
STAMP="$(date +%F)"
OUT="$BACKUP_DIR/coop-$STAMP.dump"

# -Fc = custom format (pg_restore-able, compressed). Written via a temp file so a
# failed dump never looks like a valid backup.
docker compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" -Fc >"$OUT.tmp"
mv "$OUT.tmp" "$OUT"
chmod 600 "$OUT"
find "$BACKUP_DIR" -name 'coop-*.dump' -mtime +"$RETENTION_DAYS" -delete

echo "[backup] wrote $OUT"
