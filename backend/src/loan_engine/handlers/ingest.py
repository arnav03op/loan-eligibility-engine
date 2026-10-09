"""S3 ObjectCreated → stream the uploaded CSV into RDS.

Returns {"batch_ids": [...]} for batches completed by this invocation. The
Lambda OnSuccess destination forwards that to the notify function, which
triggers n8n Workflow B. Duplicate S3 deliveries return an empty list, so
matching is never triggered twice.
"""
from __future__ import annotations

import codecs
import logging
import re
import urllib.parse

import boto3

from loan_engine import db
from loan_engine.ingest import ingest_csv

logger = logging.getLogger()
logger.setLevel(logging.INFO)

KEY_RE = re.compile(
    r"^uploads/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.csv$"
)

_s3 = None


# Makes the S3 client once and reuses it.
def _s3_client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client("s3")
    return _s3


# Runs when a CSV lands in S3: reads it and loads the users.
def handler(event, context):
    completed: list[str] = []
    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
        match = KEY_RE.match(key)
        if not match:
            logger.warning("ignoring object with unexpected key: %s", key)
            continue
        batch_id = match.group(1)

        body = _s3_client().get_object(Bucket=bucket, Key=key)["Body"]
        lines = codecs.getreader("utf-8-sig")(body)  # streams; strips an Excel BOM
        with db.connect() as conn:
            result = ingest_csv(conn, batch_id, key, lines)
        logger.info("ingest %s", result)
        if result.status == "completed":
            completed.append(batch_id)
    return {"batch_ids": completed}
