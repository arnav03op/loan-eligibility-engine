"""PostgreSQL connections for the Lambda handlers and local scripts."""
import os

import psycopg

from .config import DbSettings


# Opens a database connection using the env settings.
def connect() -> psycopg.Connection:
    """Open an autocommit connection.

    DATABASE_URL (tests and local scripts) takes precedence over the DB_* settings
    used in Lambda. Callers group statements with `conn.transaction()`.
    """
    url = os.environ.get("DATABASE_URL")
    if url:
        return psycopg.connect(url, autocommit=True, connect_timeout=10)
    settings = DbSettings.from_env()
    return psycopg.connect(
        host=settings.host,
        port=settings.port,
        dbname=settings.dbname,
        user=settings.user,
        password=settings.password,
        sslmode=settings.sslmode,
        sslrootcert=settings.sslrootcert,  # None is dropped by psycopg
        connect_timeout=10,
        application_name="loan-engine-lambda",
        autocommit=True,
    )
