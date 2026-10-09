"""Ingest OnSuccess destination → HMAC-signed POST to the n8n Workflow B webhook.

Runs outside the VPC so it can reach the internet (the cloudflared tunnel) and
SSM without a NAT Gateway. The tunnel URL lives in SSM and is re-read every
PARAM_TTL_SECONDS, so restarting the tunnel never needs a redeploy.
"""
from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request

import boto3

from loan_engine.signing import sign

logger = logging.getLogger()
logger.setLevel(logging.INFO)

RETRIES = 3
PARAM_TTL_SECONDS = 60
_cache: dict[str, tuple[float, str]] = {}


# After ingest succeeds, tells n8n with a signed webhook call.
def handler(event, context):
    batch_ids = ((event or {}).get("responsePayload") or {}).get("batch_ids") or []
    if not batch_ids:
        return {"notified": []}
    url = _param(os.environ["WEBHOOK_URL_PARAM"])
    secret = _param(os.environ["WEBHOOK_SECRET_PARAM"])
    for batch_id in batch_ids:
        status = post_signed(url, secret, batch_id)
        logger.info("webhook accepted batch %s with HTTP %s", batch_id, status)
    return {"notified": batch_ids}


# Sends the webhook with a signature and timestamp, retrying on failure.
def post_signed(
    url: str,
    secret: str,
    batch_id: str,
    *,
    retries: int = RETRIES,
    sleep=time.sleep,
    opener=urllib.request.urlopen,
) -> int:
    """POST {"batch_id": …} with X-Timestamp / X-Signature headers; return the HTTP status.

    Network errors and 5xx are retried with exponential backoff. 4xx is raised
    immediately: a bad signature or inactive workflow will not fix itself.
    """
    body = json.dumps({"batch_id": batch_id}).encode()
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        timestamp = int(time.time())
        request = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Timestamp": str(timestamp),
                "X-Signature": sign(secret, timestamp, batch_id),
                "User-Agent": "loan-engine-notify/1.0",
            },
        )
        try:
            with opener(request, timeout=10) as response:
                return response.status
        except urllib.error.HTTPError as err:
            if err.code < 500:
                raise
            last_error = err
        except (urllib.error.URLError, TimeoutError) as err:
            last_error = err
        logger.warning("webhook attempt %d/%d failed: %s", attempt, retries, last_error)
        if attempt < retries:
            sleep(2**attempt)
    raise RuntimeError(f"webhook delivery failed after {retries} attempts: {last_error}")


# Reads a secret from SSM Parameter Store.
def _param(name: str) -> str:
    now = time.monotonic()
    cached = _cache.get(name)
    if cached and now - cached[0] < PARAM_TTL_SECONDS:
        return cached[1]
    value = boto3.client("ssm").get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]
    _cache[name] = (now, value)
    return value
