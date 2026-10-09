import psycopg
import pytest

EXPECTED_TABLES = {
    "upload_batches",
    "users",
    "loan_products",
    "crawl_sources",
    "matches",
    "llm_decision_cache",
    "match_runs",
    "notifications",
}
BATCH = "11111111-1111-4111-8111-111111111111"


def test_all_tables_exist(db_url):
    with psycopg.connect(db_url) as conn:
        rows = conn.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
        ).fetchall()
    assert EXPECTED_TABLES <= {name for (name,) in rows}


def test_employment_status_is_constrained(db_url):
    with psycopg.connect(db_url, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO upload_batches (batch_id, s3_key, status) VALUES (%s, 'k', 'processing')",
            (BATCH,),
        )
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute(
                """INSERT INTO users (user_id, name, email, monthly_income, credit_score,
                                      employment_status, age, batch_id)
                   VALUES ('22222222-2222-4222-8222-222222222222', 'A', 'a@b.co',
                           1000, 700, 'Unemployed', 30, %s)""",
                (BATCH,),
            )


def test_product_criteria_are_mandatory(db_url):
    with psycopg.connect(db_url, autocommit=True) as conn:
        with pytest.raises(psycopg.errors.NotNullViolation):
            conn.execute(
                """INSERT INTO loan_products (source, lender, product_name, rate_min, rate_max,
                                              min_credit_score, min_age, max_age, employment_types,
                                              criteria_source, criteria_hash, source_url)
                   VALUES ('s', 'L', 'P', 10, 20, 700, 21, 60, ARRAY['Salaried'],
                           'explicit', 'h', 'https://x')"""
            )
