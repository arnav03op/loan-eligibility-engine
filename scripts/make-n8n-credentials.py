#!/usr/bin/env python3
"""Write n8n/.import/credentials.json from n8n/credentials.env for `n8n import:credentials`.

Credential IDs are fixed so the workflow JSON can reference them. Only
credentials whose values are filled in are written; edit credentials.env and
re-import to update them in place (same IDs).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / "n8n" / "credentials.env"
OUT = ROOT / "n8n" / ".import" / "credentials.json"

POSTGRES = {"id": "loanEngPostgres01", "name": "Loan Engine Postgres", "type": "postgres"}
GEMINI = {"id": "loanEngGemini0001", "name": "Gemini API key", "type": "httpHeaderAuth"}
AWS_SES = {"id": "loanEngAwsSes0001", "name": "Loan Engine AWS SES", "type": "aws"}


def read_env(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip()
    return values


def build(env: dict[str, str]) -> list[dict]:
    credentials = []
    if env.get("PG_HOST"):
        credentials.append({**POSTGRES, "data": {
            "host": env["PG_HOST"],
            "port": int(env.get("PG_PORT", "5432")),
            "database": env["PG_DATABASE"],
            "user": env["PG_USER"],
            "password": env["PG_PASSWORD"],
            "ssl": env.get("PG_SSL", "disable"),
            "allowUnauthorizedCerts": False,
        }})
    if env.get("GEMINI_API_KEY"):
        credentials.append({**GEMINI, "data": {"name": "x-goog-api-key", "value": env["GEMINI_API_KEY"]}})
    if env.get("AWS_SES_ACCESS_KEY_ID"):
        credentials.append({**AWS_SES, "data": {
            "region": env.get("AWS_REGION", "ap-south-1"),
            "accessKeyId": env["AWS_SES_ACCESS_KEY_ID"],
            "secretAccessKey": env["AWS_SES_SECRET_ACCESS_KEY"],
            "temporaryCredentials": False,
        }})
    return credentials


def main() -> int:
    if not ENV_FILE.exists():
        print(f"missing {ENV_FILE.relative_to(ROOT)}; copy n8n/credentials.env.example first", file=sys.stderr)
        return 1
    credentials = build(read_env(ENV_FILE))
    OUT.parent.mkdir(exist_ok=True)
    write_private(OUT, json.dumps(credentials, indent=2))
    print(f"wrote {len(credentials)} credential(s): {', '.join(c['name'] for c in credentials)}")
    print(
        f"{OUT.relative_to(ROOT)} holds plaintext secrets: delete it after `n8n import:credentials` "
        "(re-run this script to regenerate it)."
    )
    return 0


def write_private(path: Path, text: str) -> None:
    """Write `text` to a file that is mode 0600 from the moment it exists."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    path.chmod(0o600)  # O_CREAT's mode only applies to new files; tighten an existing one too


if __name__ == "__main__":
    sys.exit(main())
