#!/usr/bin/env bash
# Download the Amazon RDS CA bundle used for verify-full TLS (Lambda) and by n8n.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/certs"
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o "$ROOT/certs/rds-global-bundle.pem"
echo "saved certs/rds-global-bundle.pem ($(grep -c 'BEGIN CERTIFICATE' "$ROOT/certs/rds-global-bundle.pem") certificates)"
