"""Small helpers for API Gateway HTTP API (payload v2) handlers."""
from __future__ import annotations

import base64
import binascii
import json
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any


class HttpError(Exception):
    # Keeps the status code and message of the error.
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# Reads the request body as JSON, or raises a 400.
def parse_json_body(event: dict) -> dict:
    raw = event.get("body") or ""
    try:
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw).decode("utf-8")
        data = json.loads(raw or "{}")
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError):
        raise HttpError(400, "body must be JSON") from None
    if not isinstance(data, dict):
        raise HttpError(400, "body must be a JSON object")
    return data


# Builds a standard JSON API response.
def json_response(status: int, payload: Any) -> dict:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
        "body": json.dumps(payload, default=_json_default),
    }


# Helps JSON handle dates and decimals.
def _json_default(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    raise TypeError(f"not JSON serialisable: {type(value).__name__}")
