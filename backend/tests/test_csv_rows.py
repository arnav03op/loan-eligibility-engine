import time
from decimal import Decimal

import pytest

from loan_engine.csv_rows import (
    HeaderError,
    RowError,
    UserRow,
    normalize_header,
    parse_row,
)

VALID = {
    "user_id": "B35DE23E-755F-4C6A-81D8-F7DD99CE53EF",
    "name": " Dhruv Iyengar ",
    "email": "dhruv.iyengar@example.com",
    "monthly_income": "131000",
    "credit_score": "725",
    "employment_status": "Self-Employed",
    "age": "37",
}


def test_valid_row_is_normalised():
    assert parse_row(VALID, 2) == UserRow(
        line=2,
        user_id="b35de23e-755f-4c6a-81d8-f7dd99ce53ef",
        name="Dhruv Iyengar",
        email="dhruv.iyengar@example.com",
        monthly_income=Decimal("131000.00"),
        credit_score=725,
        employment_status="Self-Employed",
        age=37,
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("user_id", "not-a-uuid"),
        ("user_id", ""),
        ("name", ""),
        ("name", "x" * 201),
        ("email", "no-at-sign"),
        ("monthly_income", "0"),
        ("monthly_income", "-5"),
        ("monthly_income", "abc"),
        ("monthly_income", "NaN"),
        ("monthly_income", "1e400"),
        ("credit_score", "299"),
        ("credit_score", "901"),
        ("credit_score", "720.5"),
        ("employment_status", "Unemployed"),
        ("age", "17"),
        ("age", "x"),
        ("credit_score", "9e999999999"),
        ("age", "1e100000"),
        ("monthly_income", "1e100000"),
    ],
)
def test_invalid_values_are_reported_with_their_field(field, value):
    result = parse_row({**VALID, field: value}, 7)
    assert isinstance(result, RowError)
    assert (result.line, result.field) == (7, field)


def test_huge_exponents_are_rejected_without_building_huge_numbers():
    # A ten-character cell such as "9e9999999" must not expand into a
    # multi-million-digit integer: that would stall the Lambda past its timeout.
    started = time.perf_counter()
    for value in ("9e9999999", "9e999999999", "-9e999999999", "1e100000"):
        assert isinstance(parse_row({**VALID, "credit_score": value}, 2), RowError)
        assert isinstance(parse_row({**VALID, "age": value}, 2), RowError)
        assert isinstance(parse_row({**VALID, "monthly_income": value}, 2), RowError)
    assert time.perf_counter() - started < 0.5


def test_missing_cell_is_an_error():
    raw = dict(VALID)
    del raw["age"]
    result = parse_row(raw, 3)
    assert isinstance(result, RowError) and result.field == "age"


def test_lenient_but_unambiguous_formats_are_accepted():
    row = parse_row(
        {
            **VALID,
            "monthly_income": "1,31,000",
            "credit_score": "725.0",
            "employment_status": "self employed",
        },
        2,
    )
    assert isinstance(row, UserRow)
    assert (row.monthly_income, row.credit_score, row.employment_status) == (
        Decimal("131000.00"),
        725,
        "Self-Employed",
    )


def test_error_message_shows_the_offending_value():
    result = parse_row({**VALID, "user_id": "not-a-uuid"}, 3)
    assert result.as_dict() == {
        "line": 3,
        "field": "user_id",
        "message": "not a valid UUID: 'not-a-uuid'",
    }


def test_header_is_normalised_including_bom_and_case():
    names = normalize_header(
        ["﻿User_ID", " Name ", "EMAIL", "monthly_income", "credit_score",
         "employment_status", "age", "extra"]
    )
    assert names[:3] == ["user_id", "name", "email"]
    assert names[-1] == "extra"


def test_header_missing_columns_raises_listing_them():
    with pytest.raises(HeaderError, match="credit_score, age"):
        normalize_header(["user_id", "name", "email", "monthly_income", "employment_status"])


def test_empty_header_raises():
    with pytest.raises(HeaderError):
        normalize_header(None)
