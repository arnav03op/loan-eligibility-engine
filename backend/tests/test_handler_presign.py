import base64
import json

import pytest
from moto import mock_aws

from loan_engine.handlers import presign


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("UPLOAD_BUCKET", "test-uploads")
    monkeypatch.setenv("AWS_REGION", "ap-south-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")


def call(body, *, raw=None, b64=False):
    text = raw if raw is not None else json.dumps(body)
    event = {"body": base64.b64encode(text.encode()).decode() if b64 else text, "isBase64Encoded": b64}
    response = presign.handler(event, None)
    return response["statusCode"], json.loads(response["body"])


def test_returns_presigned_post_for_a_csv(env):
    with mock_aws():
        status, payload = call({"filename": "users.csv", "size": 993191})
    assert status == 201
    assert payload["key"] == f"uploads/{payload['batch_id']}.csv"
    assert payload["url"] == "https://test-uploads.s3.ap-south-1.amazonaws.com/"
    assert payload["fields"]["key"] == payload["key"]
    assert payload["fields"]["Content-Type"] == "text/csv"
    policy = json.loads(base64.b64decode(payload["fields"]["policy"]))
    assert ["content-length-range", 1, 52428800] in policy["conditions"]


def test_base64_encoded_body_is_accepted(env):
    with mock_aws():
        status, _ = call({"filename": "USERS.CSV", "size": 10}, b64=True)
    assert status == 201


@pytest.mark.parametrize(
    "body",
    [
        {"filename": "users.xlsx", "size": 10},
        {"filename": "users.csv", "size": 0},
        {"filename": "users.csv", "size": 52428801},
        {"filename": "users.csv", "size": "10"},
        {"filename": "users.csv", "size": True},
        {"filename": "users.csv"},
    ],
)
def test_rejects_bad_requests(env, body):
    status, payload = call(body)
    assert status == 400
    assert payload["error"]


def test_rejects_non_json_body(env):
    status, payload = call(None, raw="not json")
    assert (status, payload) == (400, {"error": "body must be JSON"})


@pytest.mark.parametrize("encoded", ["not base64!", "/w=="])  # bad padding; valid base64 of non-UTF-8
def test_rejects_malformed_base64_body(env, encoded):
    response = presign.handler({"body": encoded, "isBase64Encoded": True}, None)
    assert response["statusCode"] == 400
    assert json.loads(response["body"]) == {"error": "body must be JSON"}
