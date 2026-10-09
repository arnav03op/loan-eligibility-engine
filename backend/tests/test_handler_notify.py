import urllib.error

import boto3
import pytest
from moto import mock_aws

from loan_engine.handlers import notify

BATCH = "123e4567-e89b-42d3-a456-426614174000"
VECTOR = "40a2925fa09fbada925a75e4073463c48a6eb7b2e06eac97acbbbb327a2a117d"


class FakeResponse:
    status = 202

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture(autouse=True)
def clear_cache():
    notify._cache.clear()


def test_post_signed_sends_signature_headers(monkeypatch):
    seen = []
    monkeypatch.setattr(notify.time, "time", lambda: 1700000000)
    status = notify.post_signed(
        "https://n8n.example/webhook/loan-match", "s3cr3t", BATCH,
        opener=lambda request, timeout: seen.append(request) or FakeResponse(),
        sleep=lambda s: None,
    )
    assert status == 202
    request = seen[0]
    assert request.get_header("X-timestamp") == "1700000000"
    assert request.get_header("X-signature") == VECTOR
    assert request.data == b'{"batch_id": "123e4567-e89b-42d3-a456-426614174000"}'


def test_network_errors_are_retried_with_backoff():
    calls, sleeps = [], []

    def opener(request, timeout):
        calls.append(request)
        if len(calls) < 3:
            raise urllib.error.URLError("connection refused")
        return FakeResponse()

    assert notify.post_signed("https://x", "s", BATCH, opener=opener, sleep=sleeps.append) == 202
    assert (len(calls), sleeps) == (3, [2, 4])


def test_client_errors_are_not_retried():
    calls = []

    def opener(request, timeout):
        calls.append(request)
        raise urllib.error.HTTPError("https://x", 401, "Unauthorized", {}, None)

    with pytest.raises(urllib.error.HTTPError):
        notify.post_signed("https://x", "s", BATCH, opener=opener, sleep=lambda s: None)
    assert len(calls) == 1


def test_gives_up_after_retries():
    def opener(request, timeout):
        raise urllib.error.HTTPError("https://x", 502, "Bad Gateway", {}, None)

    with pytest.raises(RuntimeError, match="after 3 attempts"):
        notify.post_signed("https://x", "s", BATCH, opener=opener, sleep=lambda s: None)


@pytest.fixture
def ssm(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "ap-south-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "test")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "test")
    monkeypatch.setenv("WEBHOOK_URL_PARAM", "/loan-engine/n8n-webhook-url")
    monkeypatch.setenv("WEBHOOK_SECRET_PARAM", "/loan-engine/webhook-secret")
    with mock_aws():
        client = boto3.client("ssm", region_name="ap-south-1")
        client.put_parameter(Name="/loan-engine/n8n-webhook-url", Type="String",
                             Value="https://tunnel.example/webhook/loan-match")
        client.put_parameter(Name="/loan-engine/webhook-secret", Type="SecureString", Value="s3cr3t")
        yield client


def test_handler_posts_each_completed_batch(ssm, monkeypatch):
    posted = []
    monkeypatch.setattr(notify, "post_signed", lambda url, secret, batch_id: posted.append((url, secret, batch_id)) or 202)
    result = notify.handler({"responsePayload": {"batch_ids": [BATCH]}}, None)
    assert result == {"notified": [BATCH]}
    assert posted == [("https://tunnel.example/webhook/loan-match", "s3cr3t", BATCH)]


def test_handler_ignores_empty_payload(monkeypatch):
    monkeypatch.setattr(notify, "_param", lambda name: pytest.fail("SSM must not be read"))
    assert notify.handler({"responsePayload": {"batch_ids": []}}, None) == {"notified": []}
    assert notify.handler({}, None) == {"notified": []}


def test_parameters_are_cached_briefly_then_refreshed(ssm, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(notify.time, "monotonic", lambda: clock[0])
    assert notify._param("/loan-engine/n8n-webhook-url").startswith("https://tunnel.example")
    ssm.put_parameter(Name="/loan-engine/n8n-webhook-url", Type="String",
                      Value="https://new-tunnel.example/webhook/loan-match", Overwrite=True)
    assert notify._param("/loan-engine/n8n-webhook-url").startswith("https://tunnel.example")
    clock[0] += notify.PARAM_TTL_SECONDS + 1
    assert notify._param("/loan-engine/n8n-webhook-url").startswith("https://new-tunnel.example")
