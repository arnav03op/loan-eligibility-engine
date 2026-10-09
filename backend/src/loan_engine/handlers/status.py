"""GET /uploads/{batch_id} → batch progress, matching funnel and emails sent (polled by the UI)."""
import re

from loan_engine import batches, db
from loan_engine.http import json_response

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


# Returns the status of a batch for the upload page.
def handler(event, context):
    batch_id = ((event.get("pathParameters") or {}).get("batch_id") or "").lower()
    if not UUID_RE.match(batch_id):
        return json_response(400, {"error": "invalid batch id"})
    with db.connect() as conn:
        result = batches.get_status(conn, batch_id)
    if result is None:
        # Normal for a few seconds after upload: the ingest Lambda creates the row.
        return json_response(404, {"error": "batch not found", "batch_id": batch_id})
    return json_response(200, result)
