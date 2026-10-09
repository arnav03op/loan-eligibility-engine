#!/usr/bin/env bash
# Copy SSM /loan-engine/webhook-secret into n8n/.env (WEBHOOK_SECRET) and restart n8n,
# so the notify Lambda and Workflow B share one secret.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-ap-south-1}"
[[ -f "$ROOT/n8n/.env" ]] || { echo "error: $ROOT/n8n/.env not found" >&2; exit 1; }
set_env() {
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}
SECRET="$(aws ssm get-parameter --region "$REGION" --name /loan-engine/webhook-secret \
  --with-decryption --query Parameter.Value --output text)"
set_env "$ROOT/n8n/.env" WEBHOOK_SECRET "$SECRET"
docker compose -f "$ROOT/n8n/docker-compose.yml" up -d n8n
echo "n8n WEBHOOK_SECRET synced from SSM (n8n restarted)"
