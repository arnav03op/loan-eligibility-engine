-- 001_init.sql — core schema for the Loan Eligibility Engine.

-- One row per uploaded CSV (created by the ingest Lambda).
CREATE TABLE upload_batches (
    batch_id       uuid PRIMARY KEY,
    s3_key         text        NOT NULL,
    status         text        NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
    total_rows     integer     NOT NULL DEFAULT 0,
    inserted_rows  integer     NOT NULL DEFAULT 0,
    rejected_rows  integer     NOT NULL DEFAULT 0,
    errors         jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- first 50 row errors
    error_message  text,                                     -- fatal error when status = failed
    created_at     timestamptz NOT NULL DEFAULT now(),
    completed_at   timestamptz
);

-- Users from CSV uploads. Re-uploading a user_id updates the row and moves it to the new batch.
CREATE TABLE users (
    user_id            uuid PRIMARY KEY,
    name               text          NOT NULL,
    email              text          NOT NULL,              -- not unique: the sample repeats emails
    monthly_income     numeric(12,2) NOT NULL CHECK (monthly_income > 0),
    credit_score       integer       NOT NULL CHECK (credit_score BETWEEN 300 AND 900),
    employment_status  text          NOT NULL
        CHECK (employment_status IN ('Salaried', 'Self-Employed', 'Business')),
    age                integer       NOT NULL CHECK (age BETWEEN 18 AND 100),
    batch_id           uuid          NOT NULL REFERENCES upload_batches (batch_id),
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX users_batch_id_idx ON users (batch_id);
CREATE INDEX users_credit_income_idx ON users (credit_score, monthly_income);

-- Products discovered by Workflow A. Criteria are never NULL: missing values are
-- filled with defaults and the row is marked criteria_source = 'inferred'.
CREATE TABLE loan_products (
    product_id          serial PRIMARY KEY,
    source              text          NOT NULL,
    lender              text          NOT NULL,
    product_name        text          NOT NULL,
    rate_min            numeric(5,2)  NOT NULL,
    rate_max            numeric(5,2)  NOT NULL,
    min_monthly_income  numeric(12,2) NOT NULL,
    min_credit_score    integer       NOT NULL,
    min_age             integer       NOT NULL,
    max_age             integer       NOT NULL,
    employment_types    text[]        NOT NULL,
    max_loan_amount     numeric(14,2),
    max_tenure_months   integer,
    eligibility_notes   text,
    criteria_source     text          NOT NULL CHECK (criteria_source IN ('explicit', 'inferred')),
    criteria_hash       text          NOT NULL,   -- changes when criteria change → LLM cache invalidation
    source_url          text          NOT NULL,
    last_seen_at        timestamptz   NOT NULL DEFAULT now(),
    is_active           boolean       NOT NULL DEFAULT true,
    UNIQUE (lender, product_name)
);

-- Crawl bookkeeping: last content hash per URL lets Workflow A skip unchanged pages.
CREATE TABLE crawl_sources (
    url              text PRIMARY KEY,
    source           text        NOT NULL,
    last_hash        text,
    last_status      text        NOT NULL CHECK (last_status IN ('ok', 'unchanged', 'failed')),
    last_error       text,
    last_crawled_at  timestamptz NOT NULL DEFAULT now()
);

-- Workflow B output.
CREATE TABLE matches (
    user_id      uuid        NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    product_id   integer     NOT NULL REFERENCES loan_products (product_id) ON DELETE CASCADE,
    batch_id     uuid        NOT NULL REFERENCES upload_batches (batch_id),
    decided_by   text        NOT NULL CHECK (decided_by IN ('rules', 'llm')),
    score        integer     NOT NULL CHECK (score BETWEEN 0 AND 100),
    reason       text        NOT NULL,
    notified_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, product_id)
);
CREATE INDEX matches_batch_pending_idx ON matches (batch_id) WHERE notified_at IS NULL;

-- LLM verdicts per (profile bucket, product), reused across runs.
CREATE TABLE llm_decision_cache (
    bucket_key  text        NOT NULL,
    product_id  integer     NOT NULL REFERENCES loan_products (product_id) ON DELETE CASCADE,
    eligible    boolean     NOT NULL,
    reason      text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (bucket_key, product_id)
);

-- One row per Workflow B execution: the optimisation funnel.
CREATE TABLE match_runs (
    id                serial PRIMARY KEY,
    batch_id          uuid        NOT NULL REFERENCES upload_batches (batch_id),
    users_in_batch    integer     NOT NULL DEFAULT 0,
    products_active   integer     NOT NULL DEFAULT 0,
    pairs_total       integer     NOT NULL DEFAULT 0,
    pairs_after_sql   integer     NOT NULL DEFAULT 0,
    rules_accepted    integer     NOT NULL DEFAULT 0,
    rules_rejected    integer     NOT NULL DEFAULT 0,
    borderline_pairs  integer     NOT NULL DEFAULT 0,
    llm_buckets       integer     NOT NULL DEFAULT 0,
    llm_cache_hits    integer     NOT NULL DEFAULT 0,
    llm_calls         integer     NOT NULL DEFAULT 0,
    llm_accepted      integer     NOT NULL DEFAULT 0,
    matches_inserted  integer     NOT NULL DEFAULT 0,
    started_at        timestamptz NOT NULL,
    finished_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_runs_batch_idx ON match_runs (batch_id);

-- Workflow C audit log.
CREATE TABLE notifications (
    id              bigserial PRIMARY KEY,
    user_id         uuid        NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    batch_id        uuid        NOT NULL REFERENCES upload_batches (batch_id),
    original_email  text        NOT NULL,
    recipient       text        NOT NULL,
    status          text        NOT NULL CHECK (status IN ('sent', 'failed')),
    ses_message_id  text,
    error           text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_batch_idx ON notifications (batch_id);
