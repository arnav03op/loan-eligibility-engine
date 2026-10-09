from loan_engine.signing import sign

# Shared with n8n/code/test/signature.test.js — both languages must agree.
VECTOR = "40a2925fa09fbada925a75e4073463c48a6eb7b2e06eac97acbbbb327a2a117d"


def test_matches_shared_vector():
    assert sign("s3cr3t", 1700000000, "123e4567-e89b-42d3-a456-426614174000") == VECTOR


def test_any_input_change_changes_signature():
    base = sign("s3cr3t", 1700000000, "123e4567-e89b-42d3-a456-426614174000")
    assert sign("other", 1700000000, "123e4567-e89b-42d3-a456-426614174000") != base
    assert sign("s3cr3t", 1700000001, "123e4567-e89b-42d3-a456-426614174000") != base
    assert sign("s3cr3t", 1700000000, "123e4567-e89b-42d3-a456-426614174001") != base
