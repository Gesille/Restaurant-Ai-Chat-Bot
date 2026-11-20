#!/usr/bin/env bash
# Build, migrate and (re)start the API. Run on the VPS from anywhere:  ./deploy/deploy.sh
# GitHub Actions calls this automatically after every successful CI run on main.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env.production ] || { echo "Missing deploy/.env.production (copy .env.production.example)"; exit 1; }
[ -f .env ] || { echo "Missing deploy/.env (copy .env.example)"; exit 1; }
set -a; . ./.env; set +a
API_PORT="${API_PORT:-3000}"

C="docker compose -f docker-compose.prod.yml"

echo "== building image ($(git rev-parse --short HEAD 2>/dev/null || echo local)) =="
$C build api

echo "== starting MongoDB =="
$C up -d --wait mongo

echo "== migrating database =="
$C run --rm --no-deps api node dist/scripts/migrate.js

echo "== syncing restaurants (data/restaurants/*.json) =="
# The JSON files are the source of truth. New owner passwords never reach CI logs:
# they are redacted here and kept only on the server in deploy/credentials.log (mode 600).
redact() { sed -E 's/^(password: +)[^ ]+.*/\1********  (saved on the server: deploy\/credentials.log)/'; }
DATA_DIR="$(cd .. && pwd)/data/restaurants"
if ! SYNC_OUT="$($C run --rm --no-deps -v "$DATA_DIR:/app/data/restaurants:ro" api node dist/scripts/provisionFile.js data/restaurants 2>&1)"; then
  printf '%s\n' "$SYNC_OUT" | redact
  echo "FAILED: restaurant sync (the running version was NOT replaced)"
  exit 1
fi
printf '%s\n' "$SYNC_OUT" | redact
if grep -q '^password:' <<<"$SYNC_OUT"; then
  ( umask 077; { echo "--- $(date -u +%FT%TZ)"; printf '%s\n' "$SYNC_OUT" | grep -E '^(== |restaurant:|owner:|password:)'; } >> credentials.log )
fi

echo "== starting =="
$C up -d --remove-orphans

echo "== waiting for /health/ready =="
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${API_PORT}/health/ready" >/dev/null 2>&1; then
    echo "OK: API is live on 127.0.0.1:${API_PORT}${API_DOMAIN:+ (https://$API_DOMAIN)}"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 2
done

echo "FAILED: API did not become ready. Last logs:"
$C logs --tail 80 api
exit 1
