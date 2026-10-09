"""Shared fixtures. DB tests use the dev-db container's loan_engine_test database,
which is wiped and re-migrated for every test that requests `db_url`."""
from __future__ import annotations

import os
import pathlib

import psycopg
import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATIONS = sorted((ROOT / "db" / "migrations").glob("*.sql"))
TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://loan:loan@localhost:55432/loan_engine_test"
)


@pytest.fixture
def db_url(monkeypatch: pytest.MonkeyPatch) -> str:
    """Fresh schema; also exported as DATABASE_URL for loan_engine.db.connect()."""
    try:
        conn = psycopg.connect(TEST_DATABASE_URL, autocommit=True, connect_timeout=3)
    except psycopg.OperationalError as exc:
        pytest.fail(
            f"test database unavailable ({exc}). Start it with: "
            "docker compose -f n8n/docker-compose.yml --profile dev up -d dev-db"
        )
    name = conn.execute("SELECT current_database()").fetchone()[0]
    if not name.endswith("_test"):
        conn.close()
        pytest.fail(f"refusing to wipe non-test database: {name}")
    with conn:
        conn.execute("DROP SCHEMA public CASCADE")
        conn.execute("CREATE SCHEMA public")
        for path in MIGRATIONS:
            conn.execute(path.read_text())
    monkeypatch.setenv("DATABASE_URL", TEST_DATABASE_URL)
    return TEST_DATABASE_URL
