#!/usr/bin/env bash
# Start SES verification for SES_FROM, TEST_INBOX_ALIASES and ADMIN_ALIAS from n8n/.env.
# In the SES sandbox the sender AND every recipient must be verified; each address
# receives a confirmation email (Gmail + aliases all land in the same inbox).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-ap-south-1}"

env_value() { grep -E "^$1=" "$ROOT/n8n/.env" | cut -d= -f2- ; }
ADDRESSES="$(env_value SES_FROM),$(env_value TEST_INBOX_ALIASES),$(env_value ADMIN_ALIAS)"

for address in $(echo "$ADDRESSES" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^$' | sort -u); do
  status="$(aws sesv2 get-email-identity --region "$REGION" --email-identity "$address" \
    --query VerifiedForSendingStatus --output text 2>/dev/null || echo missing)"
  case "${status,,}" in
    true)    echo "verified                  $address" ;;
    missing) aws sesv2 create-email-identity --region "$REGION" --email-identity "$address" >/dev/null
             echo "verification email sent   $address" ;;
    *)       echo "pending (click the link)  $address" ;;
  esac
done
