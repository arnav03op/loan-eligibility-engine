#!/usr/bin/env bash
# Stop the RDS instance to save cost while the demo isn't needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-ap-south-1}"
STACK="loan-eligibility-engine-${STAGE:-dev}"

ID="$(aws cloudformation describe-stack-resource --region "$REGION" --stack-name "$STACK" \
  --logical-resource-id Database --query StackResourceDetail.PhysicalResourceId --output text)"
STATUS="$(aws rds describe-db-instances --region "$REGION" --db-instance-identifier "$ID" \
  --query 'DBInstances[0].DBInstanceStatus' --output text)"

case "$STATUS" in
  stopped|stopping)
    echo "RDS instance $ID is already $STATUS."
    exit 0
    ;;
  available) ;;
  *)
    echo "RDS instance $ID is '$STATUS'; it can only be stopped from 'available'." >&2
    exit 1
    ;;
esac

aws rds stop-db-instance --region "$REGION" --db-instance-identifier "$ID" >/dev/null
echo "RDS instance $ID is stopping."
echo "While stopped, only storage is billed."
echo "AWS automatically starts a stopped instance again after 7 days; re-run this script then."
