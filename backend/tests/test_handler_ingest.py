import boto3
import psycopg
import pytest
from moto import mock_aws

from loan_engine.handlers import ingest as ingest_handler

BUCKET = "test-uploads"
BATCH = "5b0c0f4e-3c43-4b4e-9b3a-0d6f2a1c9e11"
KEY = f"uploads/{BATCH}.csv"
HEADER = "user_id,name,email,monthly_income,credit_score,employment_status,age\n"
ROW = "b35de23e-755f-4c6a-81d8-f7dd99ce53ef,Dhruv Iyengar,dhruv@example.com,131000,725,Self-Employed,37\n"


def s3_event(key: str) -> dict:
    return {"Records": [{"s3": {"bucket": {"name": BUCKET}, "object": {"key": key}}}]}


@pytest.fixture
def s3(db_url, monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "ap-south-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")
    with mock_aws():
        client = boto3.client("s3", region_name="ap-south-1")
        client.create_bucket(
            Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": "ap-south-1"}
        )
        monkeypatch.setattr(ingest_handler, "_s3", None)  # force a client inside the mock
        yield client


def test_handler_ingests_and_returns_batch_ids(s3, db_url):  # file starts with a UTF-8 BOM
    s3.put_object(Bucket=BUCKET, Key=KEY, Body=("﻿" + HEADER + ROW).encode("utf-8"))
    assert ingest_handler.handler(s3_event(KEY), None) == {"batch_ids": [BATCH]}
    with psycopg.connect(db_url) as conn:
        assert conn.execute("SELECT count(*) FROM users").fetchone()[0] == 1


def test_duplicate_event_returns_no_batch_ids(s3):  # no second webhook for a redelivered event
    s3.put_object(Bucket=BUCKET, Key=KEY, Body=(HEADER + ROW).encode())
    ingest_handler.handler(s3_event(KEY), None)
    assert ingest_handler.handler(s3_event(KEY), None) == {"batch_ids": []}


def test_non_utf8_file_marks_batch_failed(s3, db_url):
    body = (HEADER + "b35de23e-755f-4c6a-81d8-f7dd99ce53ef,José,j@example.com,1000,700,Salaried,30\n")
    s3.put_object(Bucket=BUCKET, Key=KEY, Body=body.encode("cp1252"))
    with pytest.raises(UnicodeDecodeError):
        ingest_handler.handler(s3_event(KEY), None)
    with psycopg.connect(db_url) as conn:
        status, message = conn.execute(
            "SELECT status, error_message FROM upload_batches WHERE batch_id = %s", (BATCH,)
        ).fetchone()
    assert status == "failed"
    assert "UTF-8" in message


def test_unexpected_keys_are_ignored(s3):
    assert ingest_handler.handler(s3_event("uploads/readme.txt"), None) == {"batch_ids": []}
    assert ingest_handler.handler(s3_event("other/x.csv"), None) == {"batch_ids": []}
