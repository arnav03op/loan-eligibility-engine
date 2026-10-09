"""HMAC signing of the ingest → n8n webhook.

The signature covers "{timestamp}.{batch_id}" — the only payload field — so n8n
can verify it from the parsed body without needing the raw request bytes.
n8n rejects timestamps more than 300 s old, which blocks replays.
"""
import hashlib
import hmac


# Makes the secret signature n8n uses to trust our call.
def sign(secret: str, timestamp: int, batch_id: str) -> str:
    message = f"{timestamp}.{batch_id}".encode()
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
