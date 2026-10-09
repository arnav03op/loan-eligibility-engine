#!/usr/bin/env python3
"""Ingest a CSV straight into a database (no S3) — local stand-in for the ingest Lambda.

Usage: load-local.py <csv-file> [database-url]
Prints the IngestResult as JSON (including the new batch_id).
"""
import dataclasses
import json
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend" / "src"))

from loan_engine import db  # noqa: E402
from loan_engine.ingest import ingest_csv  # noqa: E402

DEFAULT_URL = "postgresql://loan:loan@localhost:55432/loan_engine"


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    os.environ["DATABASE_URL"] = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_URL
    batch_id = str(uuid.uuid4())
    with path.open(encoding="utf-8-sig", newline="") as lines, db.connect() as conn:
        result = ingest_csv(conn, batch_id, f"local/{path.name}", lines)
    print(json.dumps(dataclasses.asdict(result)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
