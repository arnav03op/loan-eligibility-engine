#!/usr/bin/env python3
"""End-to-end check against the deployed API: upload a CSV exactly as the UI does, then poll.

Usage: e2e_upload.py <api-url> <csv-file>
Exit code 0 once emails are sent (or matching produced no matches), 1 on failure/timeout.
"""
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

TIMEOUT_SECONDS = 15 * 60


def request_json(method: str, url: str, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as err:
        raw, status = err.read(), err.code
    try:
        return status, json.loads(raw or b"{}")
    except ValueError:
        return status, {}


def multipart(fields: dict, filename: str, content: bytes):
    boundary = uuid.uuid4().hex
    body = b""
    for name, value in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
    body += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
             "Content-Type: text/csv\r\n\r\n").encode() + content + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    api, path = sys.argv[1].rstrip("/"), Path(sys.argv[2])
    content = path.read_bytes()

    status, presign = request_json("POST", f"{api}/uploads", {"filename": path.name, "size": len(content)})
    if status != 201:
        print(f"presign failed: HTTP {status} {presign}")
        return 1
    body, content_type = multipart(presign["fields"], path.name, content)
    upload = urllib.request.Request(presign["url"], data=body, method="POST", headers={"Content-Type": content_type})
    try:
        with urllib.request.urlopen(upload, timeout=120) as response:
            print(f"S3 upload: HTTP {response.status}")
    except urllib.error.HTTPError as err:
        print(f"S3 upload failed: HTTP {err.code} {err.read()[:500].decode(errors='replace')}")
        return 1
    batch_id = presign["batch_id"]
    print(f"batch_id: {batch_id}")

    deadline = time.time() + TIMEOUT_SECONDS
    while time.time() < deadline:
        try:
            status, s = request_json("GET", f"{api}/uploads/{batch_id}")
        except OSError as err:
            print(f"transient error: {err}, retrying")
            time.sleep(5)
            continue
        if status == 200:
            run = s.get("match_run") or {}
            print(f"{s['status']:<10} inserted={s['inserted_rows']} rejected={s['rejected_rows']} "
                  f"matches={run.get('matches_inserted', '-')} emails={s['emails_sent']}")
            if s["status"] == "failed":
                print(f"ingest failed: {s['error_message']}")
                return 1
            if run and (s["emails_sent"] > 0 or run.get("matches_inserted") == 0):
                print(json.dumps(run, indent=2))
                return 0
        else:
            print(f"waiting for ingest (HTTP {status})")
        time.sleep(5)
    print("timed out")
    return 1


if __name__ == "__main__":
    sys.exit(main())
