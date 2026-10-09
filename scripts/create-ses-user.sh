#!/usr/bin/env bash
# Create IAM user loan-engine-n8n-ses that can ONLY send email through SES, create an
# access key for it and write the key into n8n/credentials.env (gitignored).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USER_NAME=loan-engine-n8n-ses
CREDENTIALS="$ROOT/n8n/credentials.env"

if ! aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  aws iam create-user --user-name "$USER_NAME" >/dev/null
  echo "created IAM user $USER_NAME"
fi
aws iam put-user-policy --user-name "$USER_NAME" --policy-name ses-send-only --policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["ses:SendEmail","ses:SendRawEmail"],"Resource":"*"}]}'

if grep -qE '^AWS_SES_ACCESS_KEY_ID=.+' "$CREDENTIALS"; then
  echo "n8n/credentials.env already holds an access key for $USER_NAME — nothing to do"
  exit 0
fi
if [[ ! -f "$CREDENTIALS" ]] || ! grep -q '^AWS_SES_ACCESS_KEY_ID=' "$CREDENTIALS" \
   || ! grep -q '^AWS_SES_SECRET_ACCESS_KEY=' "$CREDENTIALS"; then
  echo "error: $CREDENTIALS is missing or lacks AWS_SES_ACCESS_KEY_ID= / AWS_SES_SECRET_ACCESS_KEY= lines; no key created" >&2
  exit 1
fi
read -r KEY_ID SECRET < <(aws iam create-access-key --user-name "$USER_NAME" \
  --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
sed -i "s|^AWS_SES_ACCESS_KEY_ID=.*|AWS_SES_ACCESS_KEY_ID=$KEY_ID|; s|^AWS_SES_SECRET_ACCESS_KEY=.*|AWS_SES_SECRET_ACCESS_KEY=$SECRET|" "$CREDENTIALS"
if ! grep -q "^AWS_SES_ACCESS_KEY_ID=$KEY_ID$" "$CREDENTIALS"; then
  echo "error: could not write the new key into $CREDENTIALS. Delete the dangling key with:" >&2
  echo "  aws iam delete-access-key --user-name $USER_NAME --access-key-id $KEY_ID" >&2
  exit 1
fi
echo "wrote a new access key for $USER_NAME into n8n/credentials.env"
