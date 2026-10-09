"""Bulk load of validated rows: COPY into a temp table, then one set-based upsert.

COPY is PostgreSQL's fastest ingestion path, and the single INSERT … ON CONFLICT
keeps the users table consistent even when a file repeats a user_id.
"""
from __future__ import annotations

from typing import Iterable

import psycopg

from .csv_rows import UserRow

_STAGING_DDL = """
CREATE TEMP TABLE staging_users (
    line integer NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    monthly_income numeric(12,2) NOT NULL,
    credit_score integer NOT NULL,
    employment_status text NOT NULL,
    age integer NOT NULL
) ON COMMIT DROP
"""

_COPY = """
COPY staging_users (line, user_id, name, email, monthly_income, credit_score,
                    employment_status, age) FROM STDIN
"""

# A re-uploaded user is re-evaluated from scratch: matches from earlier batches are
# removed, so Workflow B decides (and Workflow C notifies) afresh for this batch.
_CLEAR_STALE_MATCHES = """
DELETE FROM matches m USING staging_users s WHERE m.user_id = s.user_id
"""

# DISTINCT ON keeps the last occurrence of a user_id within the file.
_UPSERT = """
INSERT INTO users (user_id, name, email, monthly_income, credit_score,
                   employment_status, age, batch_id)
SELECT DISTINCT ON (user_id)
       user_id, name, email, monthly_income, credit_score, employment_status, age, %(batch_id)s
FROM staging_users
ORDER BY user_id, line DESC
ON CONFLICT (user_id) DO UPDATE SET
    name = EXCLUDED.name,
    email = EXCLUDED.email,
    monthly_income = EXCLUDED.monthly_income,
    credit_score = EXCLUDED.credit_score,
    employment_status = EXCLUDED.employment_status,
    age = EXCLUDED.age,
    batch_id = EXCLUDED.batch_id,
    updated_at = now()
"""


# Saves the valid user rows into the database in one go.
def load_users(conn: psycopg.Connection, batch_id: str, rows: Iterable[UserRow]) -> int:
    """Stream `rows` into PostgreSQL. Must run inside a transaction.

    Returns the number of distinct users written (inserted or updated). Earlier
    matches of these users are deleted so they are matched again for this batch.
    """
    conn.execute(_STAGING_DDL)
    with conn.cursor() as cur:
        with cur.copy(_COPY) as copy:
            for row in rows:
                copy.write_row(
                    (
                        row.line,
                        row.user_id,
                        row.name,
                        row.email,
                        row.monthly_income,
                        row.credit_score,
                        row.employment_status,
                        row.age,
                    )
                )
        cur.execute(_UPSERT, {"batch_id": batch_id})
        written = cur.rowcount
        cur.execute(_CLEAR_STALE_MATCHES)
        return written
