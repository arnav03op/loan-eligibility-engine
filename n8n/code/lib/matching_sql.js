'use strict';
// SQL for Workflow B. Each statement returns exactly ONE row of aggregated JSON,
// so n8n handles a handful of items instead of one item per user-product pair.

const { jsonLiteral, uuidLiteral, intLiteral, timestampLiteral } = require('./sql_literal');

// SQL to fetch all active loan products.
function buildProductsSql() {
  return `SELECT coalesce(json_agg(p ORDER BY p.product_id), '[]'::json) AS products
FROM (
  SELECT product_id, lender, product_name, rate_min, rate_max, min_monthly_income, min_credit_score,
         min_age, max_age, employment_types, max_loan_amount, max_tenure_months, eligibility_notes,
         criteria_source, source_url
  FROM loan_products
  WHERE is_active
) p`;
}

// Stage 1: one indexed join applies every hard numeric/categorical criterion in
// the database, returning each user's surviving product ids as an array.
function buildStage1Sql(batchId) {
  return `WITH u AS (
  SELECT user_id, monthly_income, credit_score, employment_status, age
  FROM users WHERE batch_id = ${uuidLiteral(batchId)}
), p AS (
  SELECT product_id, min_monthly_income, min_credit_score, min_age, max_age, employment_types
  FROM loan_products WHERE is_active
), c AS (
  SELECT u.user_id, json_agg(p.product_id ORDER BY p.product_id) AS product_ids, count(*) AS n
  FROM u JOIN p
    ON u.monthly_income >= p.min_monthly_income
   AND u.credit_score >= p.min_credit_score
   AND u.age BETWEEN p.min_age AND p.max_age
   AND u.employment_status = ANY (p.employment_types)
  GROUP BY u.user_id
)
SELECT
  (SELECT count(*) FROM u)::int AS users_in_batch,
  (SELECT count(*) FROM p)::int AS products_active,
  ((SELECT count(*) FROM u) * (SELECT count(*) FROM p))::int AS pairs_total,
  (SELECT coalesce(sum(n), 0) FROM c)::int AS pairs_after_sql,
  (SELECT coalesce(json_agg(json_build_object(
      'user_id', u.user_id, 'monthly_income', u.monthly_income, 'credit_score', u.credit_score,
      'employment_status', u.employment_status, 'age', u.age, 'product_ids', c.product_ids)), '[]'::json)
   FROM c JOIN u USING (user_id)) AS candidates`;
}

// SQL to look up AI answers we already saved.
function buildCacheLookupSql(bucketPairs) {
  const pairs = bucketPairs.map(({ bucket_key, product_id }) => ({ bucket_key, product_id }));
  return `SELECT coalesce(json_agg(json_build_object(
    'bucket_key', c.bucket_key, 'product_id', c.product_id, 'eligible', c.eligible, 'reason', c.reason)), '[]'::json) AS hits
FROM llm_decision_cache c
JOIN json_to_recordset(${jsonLiteral(pairs)}) AS r(bucket_key text, product_id int) USING (bucket_key, product_id)`;
}

const STAT_FIELDS = ['users_in_batch', 'products_active', 'pairs_total', 'pairs_after_sql', 'rules_accepted',
  'rules_rejected', 'borderline_pairs', 'llm_buckets', 'llm_cache_hits', 'llm_calls'];

// Stage 4: cache new LLM verdicts, insert matches (rule matches get their reason
// written here, from the joined rows) and record the funnel — one statement.
function buildPersistSql({ batchId, startedAt, stats, matches, newCache }) {
  const batch = uuidLiteral(batchId);
  const statValues = STAT_FIELDS.map((field) => intLiteral(stats[field] ?? 0)).join(', ');
  return `WITH new_cache AS (
  INSERT INTO llm_decision_cache (bucket_key, product_id, eligible, reason)
  SELECT r.bucket_key, r.product_id, r.eligible, r.reason
  FROM json_to_recordset(${jsonLiteral(newCache)}) AS r(bucket_key text, product_id int, eligible boolean, reason text)
  WHERE EXISTS (SELECT 1 FROM loan_products lp WHERE lp.product_id = r.product_id)
  ON CONFLICT (bucket_key, product_id) DO NOTHING
  RETURNING 1
), incoming AS (
  SELECT (e->>0)::uuid AS user_id, (e->>1)::int AS product_id, (e->>2)::int AS score,
         e->>3 AS decided_by, e->>4 AS reason
  FROM json_array_elements(${jsonLiteral(matches)}) AS e
), inserted AS (
  INSERT INTO matches (user_id, product_id, batch_id, decided_by, score, reason)
  SELECT i.user_id, i.product_id, ${batch}, i.decided_by, i.score,
         coalesce(i.reason, format('CIBIL %s (min %s), income ₹%s/month (min ₹%s)',
                  u.credit_score, p.min_credit_score,
                  to_char(u.monthly_income, 'FM99,99,99,999'), to_char(p.min_monthly_income, 'FM99,99,99,999')))
  FROM incoming i
  JOIN users u ON u.user_id = i.user_id
  JOIN loan_products p ON p.product_id = i.product_id
  WHERE EXISTS (SELECT 1 FROM upload_batches ub WHERE ub.batch_id = ${batch})
  ON CONFLICT (user_id, product_id) DO NOTHING
  RETURNING decided_by
)
INSERT INTO match_runs (batch_id, ${STAT_FIELDS.join(', ')}, llm_accepted, matches_inserted, started_at, finished_at)
SELECT ${batch}, ${statValues},
       (SELECT count(*) FROM inserted WHERE decided_by = 'llm'),
       (SELECT count(*) FROM inserted),
       ${timestampLiteral(startedAt)}, now()
WHERE EXISTS (SELECT 1 FROM upload_batches ub WHERE ub.batch_id = ${batch})
RETURNING batch_id, pairs_total, pairs_after_sql, rules_accepted, borderline_pairs, llm_calls,
          llm_accepted, matches_inserted`;
}

module.exports = { buildProductsSql, buildStage1Sql, buildCacheLookupSql, buildPersistSql };
