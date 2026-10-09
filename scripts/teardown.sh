#!/usr/bin/env bash
# Remove every AWS resource of the stack (RDS is deleted without a final snapshot).
# Pass --purge-params to also delete the /loan-engine/* SSM parameters.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REGION="${AWS_REGION:-ap-south-1}"
STAGE="${STAGE:-dev}"
BUCKET="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "loan-eligibility-engine-$STAGE" \
  --query "Stacks[0].Outputs[?OutputKey=='UploadBucketName'].OutputValue" --output text 2>/dev/null || true)"
if [[ -n "$BUCKET" && "$BUCKET" != "None" ]]; then
  aws s3 rm "s3://$BUCKET" --recursive --region "$REGION"   # CloudFormation cannot delete a non-empty bucket
fi
npx serverless remove --stage "$STAGE" --region "$REGION" --verbose
if [[ "${1:-}" == "--purge-params" ]]; then
  aws ssm delete-parameters --region "$REGION" --names \
    /loan-engine/db-password /loan-engine/webhook-secret /loan-engine/n8n-webhook-url
fi
echo "Teardown complete."
