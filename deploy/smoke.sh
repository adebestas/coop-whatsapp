#!/usr/bin/env bash
#
# Go-live smoke test. Run after deploy, after every upgrade, and before inviting
# members. It checks the parts that break silently: TLS, health (DB + Redis),
# the dashboard, the WhatsApp verify handshake, and webhook signature rejection.
#
#   sudo bash deploy/smoke.sh                        # uses DOMAIN from .env
#   sudo bash deploy/smoke.sh https://mycoop.example # explicit base URL
#
# Exit code 0 = all automated checks passed. The manual checklist is printed
# afterwards; it covers the flows that need a real phone and real money rails.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

read_env() {
  local key="$1" fallback="$2" value
  value="$(grep -E "^${key}=" .env 2>/dev/null | head -n1 | cut -d= -f2- || true)"
  printf '%s' "${value:-$fallback}"
}

if [ "${1:-}" != "" ]; then
  BASE="${1%/}"
else
  DOMAIN="$(read_env DOMAIN '')"
  if [ -z "$DOMAIN" ]; then
    echo "FAIL: DOMAIN is not set in .env and no URL was passed" >&2
    exit 1
  fi
  BASE="https://${DOMAIN}"
fi

VERIFY_TOKEN="$(read_env WHATSAPP_VERIFY_TOKEN '')"
FAILED=0
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

ok() { printf '\033[1;32mPASS\033[0m %s\n' "$*"; }
bad() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; FAILED=$((FAILED + 1)); }

echo "Smoke testing $BASE"

# 1. Health: proves TLS terminates, the app answers, Postgres is reachable and
#    Redis is connected (redis:false means rate limits and locks are degraded).
CODE="$(curl -fsS -m 15 -o "$TMP" -w '%{http_code}' "$BASE/health" 2>/dev/null || true)"
if [ "$CODE" = "200" ] && grep -q '"status":"ok"' "$TMP"; then
  ok "GET /health -> 200 ok"
elif [ "$CODE" = "503" ] && grep -q '"status":"degraded"' "$TMP"; then
  bad "GET /health -> 503 degraded ($(cat "$TMP"))"
else
  bad "GET /health -> ${CODE:-no response}"
fi

# 2. Dashboard (public landing + platform console entrypoint).
CODE="$(curl -fsS -m 15 -o /dev/null -w '%{http_code}' "$BASE/" 2>/dev/null || true)"
if [ "$CODE" = "200" ]; then ok "GET / -> 200"; else bad "GET / -> ${CODE:-no response}"; fi

# 3. Meta webhook handshake: must echo hub.challenge verbatim.
if [ -n "$VERIFY_TOKEN" ]; then
  BODY="$(curl -fsS -m 15 "$BASE/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=smoke123" 2>/dev/null || true)"
  if [ "$BODY" = "smoke123" ]; then ok "webhook verify handshake echoes challenge"; else bad "webhook verify handshake returned '${BODY}'"; fi
  WRONG="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$BASE/webhook?hub.mode=subscribe&hub.verify_token=definitely-wrong&hub.challenge=smoke123" 2>/dev/null || true)"
  if [ "$WRONG" = "403" ] || [ "$WRONG" = "401" ]; then ok "webhook rejects wrong verify token ($WRONG)"; else bad "webhook accepted wrong verify token (${WRONG:-no response})"; fi
else
  bad "WHATSAPP_VERIFY_TOKEN is not set in .env"
fi

# 4. Signature gate: an unsigned POST must be refused. A 200 here means anyone
#    can inject fake member messages.
CODE="$(curl -sS -m 15 -o /dev/null -w '%{http_code}' -X POST "$BASE/webhook" \
  -H 'content-type: application/json' --data '{"object":"whatsapp_business_account","entry":[]}' 2>/dev/null || true)"
if [ "$CODE" = "401" ] || [ "$CODE" = "403" ]; then
  ok "unsigned webhook POST rejected ($CODE)"
else
  bad "unsigned webhook POST returned ${CODE:-no response} — check WHATSAPP_APP_SECRET"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "Automated checks: all passed."
else
  echo "Automated checks: $FAILED failed. Do NOT invite members until these pass."
fi

cat <<'EOF'

Manual checklist (needs a real phone + a test account; do this once per release):
  1. Join: send the coop join code, complete registration, set a PIN.
  2. Wallet: main menu shows a balance of ₦0 (account exists at signup).
  3. Savings: open a goal, deposit a small amount, confirm ledger + balance.
  4. Loan: request a loan, approve as admin, confirm disbursement posts to the
     loan receivable ledger (not cash).
  5. Repay: repay part of the loan, confirm balance and ledger legs.
  6. Withdrawal: request a withdrawal, confirm dual approval is required.
  7. Dedupe: ask the provider to re-deliver a webhook; confirm no double credit.
  8. OTP: enter five wrong codes; confirm OTP entry locks for 30 minutes.
  9. Console: log in with the seeded owner, change the temp PIN, enable 2FA,
     delete platform-owner-pin.txt, confirm the PIN never appears in logs.
EOF

exit "$FAILED"
