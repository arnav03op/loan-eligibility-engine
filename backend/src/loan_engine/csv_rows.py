"""Parsing and validation of user CSV rows.

Pure functions with no I/O so the rules can be unit-tested directly. The ingest
service feeds every data row through `parse_row`: valid rows become `UserRow`s,
invalid ones become `RowError`s that are counted and reported on the batch.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Mapping, Sequence

REQUIRED_COLUMNS = (
    "user_id",
    "name",
    "email",
    "monthly_income",
    "credit_score",
    "employment_status",
    "age",
)

# Accepted spellings (lower-cased) → canonical value stored in the database.
EMPLOYMENT_STATUSES = {
    "salaried": "Salaried",
    "self-employed": "Self-Employed",
    "self employed": "Self-Employed",
    "selfemployed": "Self-Employed",
    "business": "Business",
}

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MAX_MONTHLY_INCOME = Decimal("100000000")  # ₹10 crore a month: anything above is a data error
MAX_NAME_LENGTH = 200
MAX_EMAIL_LENGTH = 320


class HeaderError(ValueError):
    """The header row is missing or lacks required columns; the whole file is rejected."""


@dataclass(frozen=True)
class UserRow:
    line: int
    user_id: str
    name: str
    email: str
    monthly_income: Decimal
    credit_score: int
    employment_status: str
    age: int


@dataclass(frozen=True)
class RowError:
    line: int
    field: str
    message: str

    # Converts the row to a plain dictionary.
    def as_dict(self) -> dict:
        return {"line": self.line, "field": self.field, "message": self.message}


# Cleans up the column names so they're easy to match.
def normalize_header(fieldnames: Sequence[str] | None) -> list[str]:
    """Lower-case and trim column names (dropping a UTF-8 BOM); require REQUIRED_COLUMNS."""
    if not fieldnames:
        raise HeaderError("CSV file is empty or has no header row")
    names = [(name or "").replace("﻿", "").strip().lower() for name in fieldnames]
    missing = [column for column in REQUIRED_COLUMNS if column not in names]
    if missing:
        raise HeaderError(f"missing required column(s): {', '.join(missing)}")
    return names


# Checks one CSV row and returns a user or an error.
def parse_row(raw: Mapping[str, str | None], line: int) -> UserRow | RowError:
    """Validate one CSV record whose keys are normalised column names.

    Returns the first problem found, checking fields in REQUIRED_COLUMNS order.
    """

    def text(field: str) -> str:
        value = raw.get(field)
        return value.strip() if isinstance(value, str) else ""

    try:
        user_id = str(uuid.UUID(text("user_id")))
    except ValueError:
        return RowError(line, "user_id", f"not a valid UUID: {_show(text('user_id'))}")

    name = text("name")
    if not name or len(name) > MAX_NAME_LENGTH:
        return RowError(line, "name", f"must be 1-{MAX_NAME_LENGTH} characters")

    email = text("email")
    if len(email) > MAX_EMAIL_LENGTH or not EMAIL_RE.match(email):
        return RowError(line, "email", f"not a valid email address: {_show(email)}")

    income = _decimal(text("monthly_income"))
    if income is None or not (0 < income <= MAX_MONTHLY_INCOME):
        return RowError(
            line,
            "monthly_income",
            f"must be a positive amount up to {MAX_MONTHLY_INCOME}: {_show(text('monthly_income'))}",
        )

    credit_score = _integer(text("credit_score"))
    if credit_score is None or not (300 <= credit_score <= 900):
        return RowError(
            line, "credit_score", f"must be a whole number 300-900: {_show(text('credit_score'))}"
        )

    employment_status = EMPLOYMENT_STATUSES.get(text("employment_status").lower())
    if employment_status is None:
        return RowError(
            line,
            "employment_status",
            f"must be Salaried, Self-Employed or Business: {_show(text('employment_status'))}",
        )

    age = _integer(text("age"))
    if age is None or not (18 <= age <= 100):
        return RowError(line, "age", f"must be a whole number 18-100: {_show(text('age'))}")

    return UserRow(line, user_id, name, email, income, credit_score, employment_status, age)


# Reads a number with decimals, or None if it's bad.
def _decimal(value: str) -> Decimal | None:
    """Parse an amount, tolerating thousands separators (Indian or Western grouping)."""
    try:
        number = Decimal(value.replace(",", ""))
        return number.quantize(Decimal("0.01")) if number.is_finite() else None
    except InvalidOperation:  # unparsable, or too large to quantize
        return None


# Reads a whole number, or None if it's bad.
def _integer(value: str) -> int | None:
    """Parse a whole number; accepts '725.0' but rejects '720.5'."""
    try:
        number = Decimal(value)
    except InvalidOperation:
        return None
    # Check the magnitude before int(): "9e9999999" would otherwise expand into
    # a ten-million-digit integer and stall the Lambda. adjusted() is the power
    # of ten of the leading digit, so > 6 means more than seven integer digits.
    if not number.is_finite() or number.adjusted() > 6:
        return None
    if number != number.to_integral_value():
        return None
    return int(number)


# Shortens a value so error messages stay small.
def _show(value: str) -> str:
    return repr(value if len(value) <= 40 else value[:40] + "…")
