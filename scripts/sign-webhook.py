#!/usr/bin/env python3
"""Send the signed batch notification that the notify Lambda sends, to test Workflow B.

Usage: sign-webhook.py <batch_id> [webhook-url]   (secret read from n8n/.env WEBHOOK_SECRET)
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend" / "src"))

from loan_engine.handlers.notify import post_signed  # noqa: E402

DEFAULT_URL = "http://localhost:5678/webhook/loan-match"


def read_secret() -> str:
    for line in (ROOT / "n8n" / ".env").read_text().splitlines():
        if line.startswith("WEBHOOK_SECRET="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("WEBHOOK_SECRET missing from n8n/.env")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    url = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_URL
    print(f"HTTP {post_signed(url, read_secret(), sys.argv[1])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
