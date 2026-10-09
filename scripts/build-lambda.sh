#!/usr/bin/env bash
# Build build/lambda.zip: loan_engine package + Linux x86_64 wheels of runtime deps
# + the RDS CA bundle. boto3 is not bundled (the Lambda runtime provides it).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/build/lambda"

[[ -f "$ROOT/certs/rds-global-bundle.pem" ]] || "$ROOT/scripts/fetch-rds-ca.sh"

rm -rf "$ROOT/build"
mkdir -p "$BUILD/certs"
"$ROOT/.venv/bin/pip" install --quiet --target "$BUILD" \
  --platform manylinux2014_x86_64 --platform manylinux_2_28_x86_64 \
  --implementation cp --python-version 3.12 --only-binary=:all: \
  -r "$ROOT/backend/requirements.txt"
cp -r "$ROOT/backend/src/loan_engine" "$BUILD/"
find "$BUILD" -name '__pycache__' -prune -exec rm -rf {} +
cp "$ROOT/certs/rds-global-bundle.pem" "$BUILD/certs/"
(cd "$BUILD" && zip -qr ../lambda.zip .)
echo "built build/lambda.zip ($(du -h "$ROOT/build/lambda.zip" | cut -f1))"
