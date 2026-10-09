#!/usr/bin/env bash
# Apply db/migrations/*.sql in filename order to the database at $1 (a libpq URL).
# Each file runs in its own transaction and is recorded in schema_migrations, so
# re-running is safe.
set -euo pipefail

DB_URL="${1:?usage: scripts/migrate.sh <postgres-url>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PGOPTIONS='-c client_min_messages=warning'

psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"

for file in "$ROOT"/db/migrations/*.sql; do
  name="$(basename "$file")"
  if [[ "$(psql "$DB_URL" -tAq -c "SELECT 1 FROM schema_migrations WHERE filename = '$name'")" == "1" ]]; then
    echo "skip   $name"
    continue
  fi
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q --single-transaction \
    -f "$file" \
    -c "INSERT INTO schema_migrations (filename) VALUES ('$name')"
  echo "apply  $name"
done
