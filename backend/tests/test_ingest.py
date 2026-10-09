import io

import psycopg
import pytest

from loan_engine import batches
from loan_engine.csv_rows import HeaderError
from loan_engine.ingest import ingest_csv

BATCH = "5b0c0f4e-3c43-4b4e-9b3a-0d6f2a1c9e11"
HEADER = "user_id,name,email,monthly_income,credit_score,employment_status,age\n"
ROW_A = "b35de23e-755f-4c6a-81d8-f7dd99ce53ef,Dhruv Iyengar,dhruv@example.com,131000,725,Self-Employed,37\n"
ROW_B = "77fce4da-b901-4b27-b1bb-01989567b98b,Tara Khan,tara@example.com,38000,765,Salaried,36\n"


def lines(text: str) -> io.StringIO:
    return io.StringIO(text)


@pytest.fixture
def conn(db_url):
    with psycopg.connect(db_url, autocommit=True) as connection:
        yield connection


def batch_row(conn, batch_id=BATCH):
    return conn.execute(
        """SELECT status, total_rows, inserted_rows, rejected_rows, errors, error_message
           FROM upload_batches WHERE batch_id = %s""",
        (batch_id,),
    ).fetchone()


def test_valid_and_invalid_rows_are_counted(conn):
    bad = "not-a-uuid,X,x@example.com,1000,700,Salaried,30\n"
    result = ingest_csv(conn, BATCH, "uploads/x.csv", lines(HEADER + ROW_A + bad + ROW_B))

    assert (result.status, result.total_rows, result.inserted_rows, result.rejected_rows) == (
        "completed", 3, 2, 1,
    )
    status, total, inserted, rejected, errors, message = batch_row(conn)
    assert (status, total, inserted, rejected, message) == ("completed", 3, 2, 1, None)
    assert errors == [{"line": 3, "field": "user_id", "message": "not a valid UUID: 'not-a-uuid'"}]
    assert conn.execute("SELECT count(*) FROM users WHERE batch_id = %s", (BATCH,)).fetchone()[0] == 2


def test_bom_and_mixed_case_header(conn):  # Excel's UTF-8 BOM must not hide the first column
    header = "﻿User_ID, Name ,EMAIL,Monthly_Income,credit_score,employment_status,age\n"
    assert ingest_csv(conn, BATCH, "k", lines(header + ROW_A)).inserted_rows == 1


def test_duplicate_user_ids_last_row_wins(conn):
    updated = ROW_A.replace("131000", "140000")
    result = ingest_csv(conn, BATCH, "k", lines(HEADER + ROW_A + updated))
    assert (result.total_rows, result.inserted_rows) == (2, 1)
    assert conn.execute("SELECT monthly_income FROM users").fetchone()[0] == 140000


def test_reupload_updates_user_and_moves_it_to_new_batch(conn):
    ingest_csv(conn, BATCH, "k1", lines(HEADER + ROW_A))
    second = "0d9c4a3e-8a8e-4f1e-9a51-3f2f6f1d2b7c"
    ingest_csv(conn, second, "k2", lines(HEADER + ROW_A.replace(",725,", ",780,")))
    assert conn.execute("SELECT credit_score, batch_id::text FROM users").fetchall() == [(780, second)]


def test_reupload_clears_previous_matches_so_user_is_re_evaluated(conn):
    ingest_csv(conn, BATCH, "k1", lines(HEADER + ROW_A + ROW_B))
    conn.execute(
        """INSERT INTO loan_products (product_id, source, lender, product_name, rate_min, rate_max,
               min_monthly_income, min_credit_score, min_age, max_age, employment_types,
               criteria_source, criteria_hash, source_url)
           VALUES (1, 's', 'L', 'P', 10, 20, 1000, 300, 18, 99, ARRAY['Salaried'], 'explicit', 'h', 'https://x')"""
    )
    conn.execute(
        """INSERT INTO matches (user_id, product_id, batch_id, decided_by, score, reason)
           SELECT user_id, 1, batch_id, 'rules', 50, 'r' FROM users"""
    )
    second = "0d9c4a3e-8a8e-4f1e-9a51-3f2f6f1d2b7c"
    ingest_csv(conn, second, "k2", lines(HEADER + ROW_A))
    remaining = conn.execute("SELECT user_id::text FROM matches").fetchall()
    assert remaining == [("77fce4da-b901-4b27-b1bb-01989567b98b",)]  # only the user not re-uploaded


def test_redelivered_event_is_skipped(conn):  # S3 delivers events at least once
    ingest_csv(conn, BATCH, "k", lines(HEADER + ROW_A))
    again = ingest_csv(conn, BATCH, "k", lines(HEADER + ROW_A + ROW_B))
    assert again.status == "skipped"
    assert conn.execute("SELECT count(*) FROM users").fetchone()[0] == 1


def test_bad_header_marks_batch_failed(conn):
    with pytest.raises(HeaderError):
        ingest_csv(conn, BATCH, "k", lines("id,name\n1,x\n"))
    status, *_counts, message = batch_row(conn)
    assert status == "failed"
    assert "missing required column" in message


def test_failed_batch_can_be_retried(conn):
    with pytest.raises(HeaderError):
        ingest_csv(conn, BATCH, "k", lines("id\n"))
    assert ingest_csv(conn, BATCH, "k", lines(HEADER + ROW_A)).status == "completed"


def test_only_first_50_errors_are_recorded(conn):
    bad = "".join(f"bad-{i},X,x@example.com,1000,700,Salaried,30\n" for i in range(60))
    result = ingest_csv(conn, BATCH, "k", lines(HEADER + bad))
    assert (result.rejected_rows, result.inserted_rows) == (60, 0)
    assert len(batch_row(conn)[4]) == 50


def test_status_read_model(conn):
    ingest_csv(conn, BATCH, "k", lines(HEADER + ROW_A))
    status = batches.get_status(conn, BATCH)
    assert status["status"] == "completed"
    assert status["inserted_rows"] == 1
    assert status["match_run"] is None
    assert status["emails_sent"] == 0
    assert batches.get_status(conn, "00000000-0000-4000-8000-000000000000") is None
