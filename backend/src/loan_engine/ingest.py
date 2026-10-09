"""Stream a user CSV into PostgreSQL.

This is the core of the ingest Lambda, kept free of S3 so it can be tested
directly and reused by scripts/load-local.py.
"""
from __future__ import annotations

import csv
from dataclasses import dataclass, field
from typing import Iterable, Iterator

import psycopg

from . import batches, user_loader
from .csv_rows import RowError, UserRow, normalize_header, parse_row

MAX_RECORDED_ERRORS = 50


@dataclass(frozen=True)
class IngestResult:
    batch_id: str
    status: str  # "completed" or "skipped" (already ingested)
    total_rows: int = 0
    inserted_rows: int = 0
    rejected_rows: int = 0


@dataclass
class _Tally:
    total: int = 0
    rejected: int = 0
    errors: list[dict] = field(default_factory=list)


# Reads the CSV line by line, loads good rows, counts bad ones.
def ingest_csv(
    conn: psycopg.Connection, batch_id: str, s3_key: str, lines: Iterable[str]
) -> IngestResult:
    """Validate and upsert every data row in `lines` for `batch_id`.

    `conn` must be in autocommit mode: the claim commits on its own (so the UI
    sees 'processing'), then loading and completion commit atomically. Any
    exception marks the batch 'failed' and is re-raised so Lambda can retry.
    """
    if not batches.claim(conn, batch_id, s3_key):
        return IngestResult(batch_id, "skipped")
    tally = _Tally()
    try:
        with conn.transaction():
            if batches.lock(conn, batch_id) == "completed":
                return IngestResult(batch_id, "skipped")
            inserted = user_loader.load_users(conn, batch_id, _valid_rows(lines, tally))
            batches.complete(
                conn,
                batch_id,
                total_rows=tally.total,
                inserted_rows=inserted,
                rejected_rows=tally.rejected,
                errors=tally.errors,
            )
    except Exception as exc:
        try:
            batches.fail(conn, batch_id, _describe(exc))
        except psycopg.Error:
            pass  # the connection itself is broken; the original error below matters more
        raise
    return IngestResult(batch_id, "completed", tally.total, inserted, tally.rejected)


# Gives only the good rows and counts the bad ones.
def _valid_rows(lines: Iterable[str], tally: _Tally) -> Iterator[UserRow]:
    reader = csv.DictReader(lines)
    reader.fieldnames = normalize_header(reader.fieldnames)
    for raw in reader:
        tally.total += 1
        result = parse_row(raw, reader.line_num)
        if isinstance(result, RowError):
            tally.rejected += 1
            if len(tally.errors) < MAX_RECORDED_ERRORS:
                tally.errors.append(result.as_dict())
        else:
            yield result


# Turns an error into a short readable message.
def _describe(exc: Exception) -> str:
    if isinstance(exc, UnicodeDecodeError):
        return f"file must be UTF-8 encoded (invalid byte at position {exc.start})"
    return f"{type(exc).__name__}: {exc}"
