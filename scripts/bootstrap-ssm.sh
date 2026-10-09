#!/usr/bin/env bash
# Create the SSM parameters the stack and n8n rely on. Existing values are never
# overwritten (so re-running cannot rotate the database password by accident).
set -euo pipefail
REGION="${AWS_REGION:-ap-south-1}"

put_if_missing() {
  local name="$1" type="$2" value="$3"
  if aws ssm get-parameter --region "$REGION" --name "$name" >/dev/null 2>&1; then
    echo "exists   $name"
  else
    aws ssm put-parameter --region "$REGION" --name "$name" --type "$type" --value "$value" >/dev/null
    echo "created  $name"
  fi
}

# Alphanumeric only: RDS forbids / @ " and spaces in passwords, and it keeps URLs simple.
DB_PASSWORD="$(python3 -c 'import secrets, string; a = string.ascii_letters + string.digits; print("".join(secrets.choice(a) for _ in range(32)))')"
WEBHOOK_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"

put_if_missing /loan-engine/db-password SecureString "$DB_PASSWORD"
put_if_missing /loan-engine/webhook-secret SecureString "$WEBHOOK_SECRET"
put_if_missing /loan-engine/n8n-webhook-url String "https://example.invalid/webhook/loan-match"
