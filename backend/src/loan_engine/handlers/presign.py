"""POST /uploads → an S3 presigned POST, so the browser uploads the CSV directly to S3.

The file never passes through API Gateway or Lambda (avoiding the 10 MB payload
and 30 s timeout limits). The POST policy makes S3 itself enforce the size cap
and content type.
"""
from __future__ import annotations

import os
import uuid

import boto3
from botocore.config import Config

from loan_engine.http import HttpError, json_response, parse_json_body

MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
URL_TTL_SECONDS = 600


# Gives the browser a safe one-time URL to upload the CSV to S3.
def handler(event, context):
    try:
        body = parse_json_body(event)
        _validate(body)
    except HttpError as err:
        return json_response(err.status, {"error": err.message})

    batch_id = str(uuid.uuid4())
    key = f"uploads/{batch_id}.csv"
    post = _s3().generate_presigned_post(
        Bucket=os.environ["UPLOAD_BUCKET"],
        Key=key,
        Fields={"Content-Type": "text/csv"},
        Conditions=[{"Content-Type": "text/csv"}, ["content-length-range", 1, MAX_UPLOAD_BYTES]],
        ExpiresIn=URL_TTL_SECONDS,
    )
    return json_response(
        201, {"batch_id": batch_id, "key": key, "url": post["url"], "fields": post["fields"]}
    )


# Checks the upload request looks right.
def _validate(body: dict) -> None:
    filename = str(body.get("filename", ""))
    size = body.get("size")
    if not filename.lower().endswith(".csv"):
        raise HttpError(400, "only .csv files are accepted")
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_UPLOAD_BYTES:
        raise HttpError(400, f"size must be an integer between 1 and {MAX_UPLOAD_BYTES} bytes")


# Makes the S3 client once and reuses it.
def _s3():
    # Regional virtual-hosted endpoint: the global endpoint would 307-redirect
    # browser POSTs for buckets outside us-east-1, which breaks CORS.
    region = os.environ.get("AWS_REGION", "ap-south-1")
    return boto3.client(
        "s3",
        region_name=region,
        endpoint_url=f"https://s3.{region}.amazonaws.com",
        config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
    )
