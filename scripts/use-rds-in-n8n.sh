#!/usr/bin/env bash
# Point n8n's "Loan Engine Postgres" credential at the deployed RDS instance (TLS verified).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-ap-south-1}"
STACK="loan-eligibility-engine-${STAGE:-dev}"
F="$ROOT/n8n/credentials.env"
[[ -f "$F" ]] || { echo "error: $F not found" >&2; exit 1; }
set_env() {
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}
HOST="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='DatabaseHost'].OutputValue" --output text)"
PASSWORD="$(aws ssm get-parameter --region "$REGION" --name /loan-engine/db-password \
  --with-decryption --query Parameter.Value --output text)"
set_env "$F" PG_HOST "$HOST"
set_env "$F" PG_DATABASE loan_engine
set_env "$F" PG_USER loan_admin
set_env "$F" PG_PASSWORD "$PASSWORD"
set_env "$F" PG_SSL require
python3 "$ROOT/scripts/make-n8n-credentials.py"
docker compose -f "$ROOT/n8n/docker-compose.yml" exec -T n8n n8n import:credentials --input=/import/credentials/credentials.json
echo "n8n now uses RDS at $HOST"
