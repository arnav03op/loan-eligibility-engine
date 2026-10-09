"""upload_batches state transitions and the status read model used by the UI."""
from __future__ import annotations

from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


# Marks this batch as ours so the same file is never processed twice.
def claim(conn: psycopg.Connection, batch_id: str, s3_key: str) -> bool:
    """Mark the batch 'processing' (committed immediately so the UI can show it).

    Returns False when the batch already completed — a duplicate S3 event.
    """
    row = conn.execute(
        """
        INSERT INTO upload_batches (batch_id, s3_key, status)
        VALUES (%s, %s, 'processing')
        ON CONFLICT (batch_id) DO UPDATE
            SET status = 'processing', error_message = NULL
            WHERE upload_batches.status <> 'completed'
        RETURNING batch_id
        """,
        (batch_id, s3_key),
    ).fetchone()
    return row is not None


# Locks the batch row so two runs can't clash.
def lock(conn: psycopg.Connection, batch_id: str) -> str:
    """Inside a transaction: serialise concurrent ingests of one batch; return its status."""
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (batch_id,))
    (status,) = conn.execute(
        "SELECT status FROM upload_batches WHERE batch_id = %s", (batch_id,)
    ).fetchone()
    return status


# Marks the batch as done and stores the counts.
def complete(
    conn: psycopg.Connection,
    batch_id: str,
    *,
    total_rows: int,
    inserted_rows: int,
    rejected_rows: int,
    errors: list[dict],
) -> None:
    conn.execute(
        """
        UPDATE upload_batches
        SET status = 'completed', total_rows = %s, inserted_rows = %s, rejected_rows = %s,
            errors = %s, error_message = NULL, completed_at = now()
        WHERE batch_id = %s
        """,
        (total_rows, inserted_rows, rejected_rows, Jsonb(errors), batch_id),
    )


# Marks the batch as failed with the reason.
def fail(conn: psycopg.Connection, batch_id: str, message: str) -> None:
    conn.execute(
        """
        UPDATE upload_batches
        SET status = 'failed', error_message = %s, completed_at = now()
        WHERE batch_id = %s AND status <> 'completed'
        """,
        (message[:1000], batch_id),
    )


_STATUS_SQL = """
SELECT b.batch_id::text, b.status, b.total_rows, b.inserted_rows, b.rejected_rows,
       b.errors, b.error_message, b.created_at, b.completed_at,
       (SELECT row_to_json(r)
          FROM (SELECT users_in_batch, products_active, pairs_total, pairs_after_sql,
                       rules_accepted, rules_rejected, borderline_pairs, llm_buckets,
                       llm_cache_hits, llm_calls, llm_accepted, matches_inserted, finished_at
                  FROM match_runs WHERE batch_id = b.batch_id
                 -- A later no-op re-run (0 inserted) must not hide the real funnel.
                 ORDER BY (matches_inserted > 0) DESC, id DESC LIMIT 1) r) AS match_run,
       (SELECT count(*) FROM notifications n
         WHERE n.batch_id = b.batch_id AND n.status = 'sent')::int AS emails_sent
FROM upload_batches b
WHERE b.batch_id = %s
"""


# Fetches the batch's current status for the UI.
def get_status(conn: psycopg.Connection, batch_id: str) -> dict[str, Any] | None:
    """Batch progress + matching funnel + emails sent, or None if unknown.

    The funnel is the latest match run that inserted matches, else the latest run.
    """
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(_STATUS_SQL, (batch_id,)).fetchone()
