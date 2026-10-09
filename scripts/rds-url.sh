#!/usr/bin/env bash
# Print a verify-full libpq URL for the deployed RDS instance (used by migrate.sh and psql).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_REGION:-ap-south-1}"
STACK="loan-eligibility-engine-${STAGE:-dev}"
HOST="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='DatabaseHost'].OutputValue" --output text)"
PASSWORD="$(aws ssm get-parameter --region "$REGION" --name /loan-engine/db-password \
  --with-decryption --query Parameter.Value --output text)"
echo "postgresql://loan_admin:${PASSWORD}@${HOST}:5432/loan_engine?sslmode=verify-full&sslrootcert=${ROOT}/certs/rds-global-bundle.pem"
