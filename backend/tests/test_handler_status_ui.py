import json

import psycopg

from loan_engine.handlers import status, ui

BATCH = "5b0c0f4e-3c43-4b4e-9b3a-0d6f2a1c9e11"


def get(batch_id):
    response = status.handler({"pathParameters": {"batch_id": batch_id}}, None)
    return response["statusCode"], json.loads(response["body"])


def test_malformed_batch_id_is_400(db_url):
    assert get("not-a-uuid")[0] == 400


def test_unknown_batch_is_404(db_url):
    code, body = get(BATCH)
    assert (code, body["batch_id"]) == (404, BATCH)


def test_completed_batch_includes_funnel_and_emails(db_url):
    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute(
            """INSERT INTO upload_batches (batch_id, s3_key, status, total_rows, inserted_rows, completed_at)
               VALUES (%s, 'k', 'completed', 10, 10, now())""",
            (BATCH,),
        )
        conn.execute(
            """INSERT INTO users (user_id, name, email, monthly_income, credit_score,
                                  employment_status, age, batch_id)
               VALUES ('b35de23e-755f-4c6a-81d8-f7dd99ce53ef', 'D', 'd@example.com', 50000, 700,
                       'Salaried', 30, %s)""",
            (BATCH,),
        )
        conn.execute(
            """INSERT INTO match_runs (batch_id, pairs_total, pairs_after_sql, matches_inserted, started_at)
               VALUES (%s, 350, 120, 90, now())""",
            (BATCH,),
        )
        conn.execute(
            """INSERT INTO notifications (user_id, batch_id, original_email, recipient, status)
               VALUES ('b35de23e-755f-4c6a-81d8-f7dd99ce53ef', %s, 'd@example.com', 'me+one@gmail.com', 'sent')""",
            (BATCH,),
        )
    code, body = get(BATCH.upper())
    assert code == 200
    assert body["status"] == "completed"
    assert body["match_run"]["pairs_after_sql"] == 120
    assert body["emails_sent"] == 1


def test_noop_rerun_does_not_hide_the_real_funnel(db_url):
    # A later match run that inserted nothing (e.g. a re-trigger where every pair
    # already matched) must not replace the funnel of the run that did the work.
    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute(
            """INSERT INTO upload_batches (batch_id, s3_key, status, total_rows, inserted_rows, completed_at)
               VALUES (%s, 'k', 'completed', 10, 10, now())""",
            (BATCH,),
        )
        conn.execute(
            """INSERT INTO match_runs (batch_id, pairs_total, pairs_after_sql, matches_inserted, started_at)
               VALUES (%s, 350, 120, 90, now()), (%s, 350, 120, 0, now())""",
            (BATCH, BATCH),
        )
    code, body = get(BATCH)
    assert code == 200
    assert body["match_run"]["matches_inserted"] == 90


def test_latest_run_is_shown_when_no_run_inserted_matches(db_url):
    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute(
            """INSERT INTO upload_batches (batch_id, s3_key, status, total_rows, inserted_rows, completed_at)
               VALUES (%s, 'k', 'completed', 10, 10, now())""",
            (BATCH,),
        )
        conn.execute(
            """INSERT INTO match_runs (batch_id, pairs_total, pairs_after_sql, matches_inserted, started_at)
               VALUES (%s, 350, 0, 0, now()), (%s, 350, 7, 0, now())""",
            (BATCH, BATCH),
        )
    assert get(BATCH)[1]["match_run"]["pairs_after_sql"] == 7


def test_ui_serves_the_upload_page():
    response = ui.handler({}, None)
    assert response["statusCode"] == 200
    assert response["headers"]["Content-Type"].startswith("text/html")
    assert "<title>Loan Eligibility Engine</title>" in response["body"]
