#!/usr/bin/env bash
#
# Uptime watchdog. Installed to /usr/local/bin/coop-uptime.sh by
# deploy/bootstrap.sh and run from /etc/cron.d/coop-whatsapp-uptime every
# 5 minutes. Alerts only on state changes (down / recovered) so the channel is
# not spammed; a failed check is also appended to /var/log/coop-uptime.log.
#
#   sudo /usr/local/bin/coop-uptime.sh
#
# Alerts go to Telegram when TELEGRAM_BOT_TOKEN and ALERT_TELEGRAM_CHAT_ID are
# set in .env. Without them the check still runs and logs.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/coop-whatsapp}"
STATE_FILE="${STATE_FILE:-/var/lib/coop-uptime.state}"
LOG_FILE="${LOG_FILE:-/var/log/coop-uptime.log}"

cd "$APP_DIR" || exit 1

read_env() {
  local key="$1" fallback="$2" value
  value="$(grep -E "^${key}=" .env 2>/dev/null | head -n1 | cut -d= -f2- || true)"
  printf '%s' "${value:-$fallback}"
}

DOMAIN="$(read_env DOMAIN '')"
if [ -z "$DOMAIN" ]; then
  echo "$(date -Is) FAIL DOMAIN not set" >>"$LOG_FILE"
  exit 1
fi

BOT_TOKEN="$(read_env TELEGRAM_BOT_TOKEN '')"
CHAT_ID="$(read_env ALERT_TELEGRAM_CHAT_ID '')"
URL="https://${DOMAIN}/health"

notify() {
  local text="$1"
  echo "$(date -Is) $text" >>"$LOG_FILE"
  if [ -n "$BOT_TOKEN" ] && [ -n "$CHAT_ID" ]; then
    curl -fsS -m 15 -o /dev/null \
      --data-urlencode "chat_id=${CHAT_ID}" \
      --data-urlencode "text=${text}" \
      "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" || true
  fi
}

PREV="$(cat "$STATE_FILE" 2>/dev/null || echo unknown)"
CODE="$(curl -fsS -m 20 -o /tmp/coop-health.out -w '%{http_code}' "$URL" 2>/dev/null || true)"
BODY="$(cat /tmp/coop-health.out 2>/dev/null || true)"

if [ "$CODE" = "200" ] && printf '%s' "$BODY" | grep -q '"status":"ok"'; then
  printf 'up' >"$STATE_FILE"
  if [ "$PREV" = "down" ] || [ "$PREV" = "degraded" ]; then
    notify "RECOVERED: ${DOMAIN} is healthy again"
  fi
  exit 0
fi

printf 'down' >"$STATE_FILE"
if [ "$CODE" = "503" ]; then
  notify "DEGRADED: ${DOMAIN}/health returned 503 (${BODY})"
elif [ "$PREV" != "down" ]; then
  notify "DOWN: ${DOMAIN}/health unreachable (http '${CODE:-none}')"
fi
exit 1
