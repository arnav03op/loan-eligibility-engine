'use strict';
// SQL for Workflow A. Each builder returns ONE statement that returns ONE row,
// so the n8n Postgres node always emits exactly one item.

const { jsonLiteral, quoteLiteral } = require('./sql_literal');

const PRODUCT_RECORD = `source text, source_url text, lender text, product_name text,
    rate_min numeric, rate_max numeric, min_monthly_income numeric, min_credit_score int,
    min_age int, max_age int, employment_types text[], max_loan_amount numeric,
    max_tenure_months int, eligibility_notes text, criteria_source text, criteria_hash text`;

// Writes a value as SQL text, or NULL if empty.
const nullable = (value) => (value === null || value === undefined ? 'NULL' : quoteLiteral(value));

// SQL to load the last fingerprint of each page.
function buildCrawlStateSql(urls) {
  return `SELECT coalesce(json_agg(json_build_object('url', url, 'last_hash', last_hash)), '[]'::json) AS state
FROM crawl_sources
WHERE url IN (SELECT json_array_elements_text(${jsonLiteral(urls)}))`;
}

// A NULL hash keeps the previous one: a failed crawl must not mark content as seen.
function crawlSourceUpsert(page, status, hash, error) {
  return `INSERT INTO crawl_sources (url, source, last_hash, last_status, last_error, last_crawled_at)
  VALUES (${quoteLiteral(page.url)}, ${quoteLiteral(page.source)}, ${nullable(hash)}, ${quoteLiteral(status)}, ${nullable(error)}, now())
  ON CONFLICT (url) DO UPDATE SET
    source = EXCLUDED.source,
    last_hash = coalesce(EXCLUDED.last_hash, crawl_sources.last_hash),
    last_status = EXCLUDED.last_status,
    last_error = EXCLUDED.last_error,
    last_crawled_at = now()
  RETURNING last_status`;
}

// SQL to record if a page worked or failed.
function buildCrawlStatusSql(page, status, error) {
  const message = error ? String(error).slice(0, 1000) : null;
  return `WITH crawl AS (
  ${crawlSourceUpsert(page, status, null, message)}
)
SELECT ${quoteLiteral(page.source)} AS source, (SELECT last_status FROM crawl) AS status, 0 AS products_upserted`;
}

// SQL to mark a page as checked but unchanged.
function buildUnchangedSql(page) {
  return `WITH touched AS (
  UPDATE loan_products SET last_seen_at = now()
  WHERE source = ${quoteLiteral(page.source)} AND is_active
  RETURNING 1
), crawl AS (
  ${crawlSourceUpsert(page, 'unchanged', null, null)}
)
SELECT ${quoteLiteral(page.source)} AS source, (SELECT last_status FROM crawl) AS status,
  (SELECT count(*) FROM touched)::int AS products_touched`;
}

// SQL to save products and turn off missing ones.
function buildUpsertProductsSql(page, products) {
  const source = quoteLiteral(page.source);
  const ownership = page.kind === 'lender' ? 'true' : `loan_products.source = ${source}`;
  return `WITH incoming AS (
  SELECT * FROM json_to_recordset(${jsonLiteral(products)}) AS r(${PRODUCT_RECORD})
), previous AS (
  SELECT lp.product_id, lp.criteria_hash
  FROM loan_products lp JOIN incoming i USING (lender, product_name)
), upserted AS (
  INSERT INTO loan_products (source, source_url, lender, product_name, rate_min, rate_max,
      min_monthly_income, min_credit_score, min_age, max_age, employment_types, max_loan_amount,
      max_tenure_months, eligibility_notes, criteria_source, criteria_hash, last_seen_at, is_active)
  SELECT source, source_url, lender, product_name, rate_min, rate_max, min_monthly_income,
      min_credit_score, min_age, max_age, employment_types, max_loan_amount, max_tenure_months,
      eligibility_notes, criteria_source, criteria_hash, now(), true
  FROM incoming
  ON CONFLICT (lender, product_name) DO UPDATE SET
      source = EXCLUDED.source,
      source_url = EXCLUDED.source_url,
      rate_min = EXCLUDED.rate_min,
      rate_max = EXCLUDED.rate_max,
      min_monthly_income = EXCLUDED.min_monthly_income,
      min_credit_score = EXCLUDED.min_credit_score,
      min_age = EXCLUDED.min_age,
      max_age = EXCLUDED.max_age,
      employment_types = EXCLUDED.employment_types,
      max_loan_amount = EXCLUDED.max_loan_amount,
      max_tenure_months = EXCLUDED.max_tenure_months,
      eligibility_notes = EXCLUDED.eligibility_notes,
      criteria_source = EXCLUDED.criteria_source,
      criteria_hash = EXCLUDED.criteria_hash,
      last_seen_at = now(),
      is_active = true
    -- ownership by source kind: a lender page always wins; an aggregator only updates rows it owns
    WHERE ${ownership}
  RETURNING product_id, criteria_hash
), deactivated AS (
  UPDATE loan_products SET is_active = false
  WHERE source = ${source} AND is_active
    AND (lender, product_name) NOT IN (SELECT lender, product_name FROM incoming)
  RETURNING product_id
), invalidated AS (
  DELETE FROM llm_decision_cache c
  USING upserted u LEFT JOIN previous p USING (product_id)
  WHERE c.product_id = u.product_id AND p.criteria_hash IS DISTINCT FROM u.criteria_hash
  RETURNING c.product_id
), crawl AS (
  ${crawlSourceUpsert(page, 'ok', page.hash, null)}
)
SELECT ${source} AS source, (SELECT last_status FROM crawl) AS status,
  (SELECT count(*) FROM upserted)::int AS products_upserted,
  (SELECT count(*) FROM deactivated)::int AS products_deactivated,
  (SELECT count(DISTINCT product_id) FROM invalidated)::int AS products_cache_invalidated`;
}

module.exports = { buildCrawlStateSql, buildCrawlStatusSql, buildUnchangedSql, buildUpsertProductsSql };
