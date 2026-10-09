#!/usr/bin/env bash
# Start the RDS instance again and bring the pipeline back (fresh tunnel URL).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-ap-south-1}"
STACK="loan-eligibility-engine-${STAGE:-dev}"

ID="$(aws cloudformation describe-stack-resource --region "$REGION" --stack-name "$STACK" \
  --logical-resource-id Database --query StackResourceDetail.PhysicalResourceId --output text)"
STATUS="$(aws rds describe-db-instances --region "$REGION" --db-instance-identifier "$ID" \
  --query 'DBInstances[0].DBInstanceStatus' --output text)"

case "$STATUS" in
  stopped)
    aws rds start-db-instance --region "$REGION" --db-instance-identifier "$ID" >/dev/null
    echo "RDS instance $ID is starting (about 5–10 minutes)."
    ;;
  available)
    echo "RDS instance $ID is already running."
    ;;
  *)
    echo "RDS instance $ID status: $STATUS"
    ;;
esac

aws rds wait db-instance-available --region "$REGION" --db-instance-identifier "$ID"
echo "RDS instance $ID is available."

"$ROOT/scripts/start-tunnel.sh"

echo "Reminder: n8n must be running (docker compose -f n8n/docker-compose.yml up -d n8n); if your home IP changed, scripts/deploy.sh refreshes the RDS allow-list."
