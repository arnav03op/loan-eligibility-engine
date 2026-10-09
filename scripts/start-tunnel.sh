#!/usr/bin/env bash
# Start the cloudflared quick tunnel and publish its webhook URL to SSM, where the notify
# Lambda reads it. Re-run after every tunnel restart: quick-tunnel URLs change.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-ap-south-1}"
COMPOSE=(docker compose -f "$ROOT/n8n/docker-compose.yml" --profile tunnel)

"${COMPOSE[@]}" up -d --force-recreate tunnel
URL=""
for _ in $(seq 1 30); do
  URL="$("${COMPOSE[@]}" logs tunnel 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | grep -v '^https://api\.' | tail -1 || true)"
  [[ -n "$URL" ]] && break
  sleep 2
done
if [[ -z "$URL" ]]; then
  echo "tunnel URL not found; inspect: docker compose -f n8n/docker-compose.yml --profile tunnel logs tunnel" >&2
  exit 1
fi
WEBHOOK="$URL/webhook/loan-match"
aws ssm put-parameter --region "$REGION" --name /loan-engine/n8n-webhook-url --type String \
  --value "$WEBHOOK" --overwrite >/dev/null
echo "webhook URL published to SSM: $WEBHOOK"
