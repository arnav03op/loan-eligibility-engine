"""Database settings read from environment variables (set by serverless.yml)."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class DbSettings:
    host: str
    port: int
    dbname: str
    user: str
    password: str
    sslmode: str
    sslrootcert: str | None

    # Builds the database settings from environment variables.
    @classmethod
    def from_env(cls) -> "DbSettings":
        return cls(
            host=os.environ["DB_HOST"],
            port=int(os.environ.get("DB_PORT", "5432")),
            dbname=os.environ["DB_NAME"],
            user=os.environ["DB_USER"],
            password=os.environ["DB_PASSWORD"],
            sslmode=os.environ.get("DB_SSLMODE", "verify-full"),
            sslrootcert=os.environ.get("DB_SSLROOTCERT") or None,
        )
