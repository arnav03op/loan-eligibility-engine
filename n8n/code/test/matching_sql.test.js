const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers/db');
const { buildProductsSql, buildStage1Sql, buildCacheLookupSql, buildPersistSql } = require('../lib/matching_sql');

const BATCH = '5b0c0f4e-3c43-4b4e-9b3a-0d6f2a1c9e11';
const U = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'];

async function seed(db) {
  await db.query(`INSERT INTO upload_batches (batch_id, s3_key, status) VALUES ('${BATCH}', 'k', 'completed')`);
  await db.query(`INSERT INTO users (user_id, name, email, monthly_income, credit_score, employment_status, age, batch_id) VALUES
    ('${U[0]}', 'Rich', 'r@example.com', 150000, 800, 'Salaried', 30, '${BATCH}'),
    ('${U[1]}', 'Low', 'l@example.com', 20000, 820, 'Salaried', 30, '${BATCH}'),
    ('${U[2]}', 'SE', 's@example.com', 90000, 760, 'Self-Employed', 40, '${BATCH}')`);
  await db.query(`INSERT INTO loan_products (product_id, source, lender, product_name, rate_min, rate_max, min_monthly_income,
      min_credit_score, min_age, max_age, employment_types, criteria_source, criteria_hash, source_url, is_active) VALUES
    (1, 's', 'A', 'Salaried only', 10, 20, 25000, 700, 21, 60, ARRAY['Salaried'], 'explicit', 'h', 'https://a', true),
    (2, 's', 'B', 'Everyone', 11, 22, 50000, 750, 21, 58, ARRAY['Salaried','Self-Employed','Business'], 'explicit', 'h', 'https://b', true),
    (3, 's', 'C', 'Inactive', 9, 12, 1000, 300, 18, 99, ARRAY['Salaried'], 'explicit', 'h', 'https://c', false)`);
}

test('stage 1 keeps only pairs meeting the hard criteria, one row per user', async () => {
  const db = await freshDb();
  try {
    await seed(db);
    const { rows: [products] } = await db.query(buildProductsSql());
    assert.deepEqual(products.products.map((p) => p.product_id), [1, 2]);

    const { rows } = await db.query(buildStage1Sql(BATCH));
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.deepEqual([r.users_in_batch, r.products_active, r.pairs_total, r.pairs_after_sql], [3, 2, 6, 3]);
    const byUser = Object.fromEntries(r.candidates.map((c) => [c.user_id, c.product_ids]));
    assert.deepEqual(byUser, { [U[0]]: [1, 2], [U[2]]: [2] });
    assert.equal(typeof r.candidates[0].monthly_income, 'number');
  } finally {
    await db.end();
  }
});

test('stage 1 on an unknown batch still returns one row with no candidates', async () => {
  const db = await freshDb();
  try {
    await seed(db);
    const { rows } = await db.query(buildStage1Sql('00000000-0000-4000-8000-000000000000'));
    assert.deepEqual([rows.length, rows[0].pairs_total, rows[0].candidates], [1, 0, []]);
  } finally {
    await db.end();
  }
});

test('persist writes matches, cache and run stats in one statement and is idempotent', async () => {
  const db = await freshDb();
  try {
    await seed(db);
    const args = {
      batchId: BATCH,
      startedAt: '2026-10-07T10:00:00Z',
      stats: { users_in_batch: 3, products_active: 2, pairs_total: 6, pairs_after_sql: 3, rules_accepted: 2, rules_rejected: 0, borderline_pairs: 1, llm_buckets: 1, llm_cache_hits: 0, llm_calls: 1 },
      matches: [[U[0], 1, 100, 'rules', null], [U[0], 2, 90, 'rules', null], [U[2], 2, 40, 'llm', "Stable business; O'Brien said $1; ok"]],
      newCache: [{ bucket_key: 'inc75000|cs750|Self-Employed|age35', product_id: 2, eligible: true, reason: 'Stable business' }],
    };
    const { rows: [run] } = await db.query(buildPersistSql(args));
    assert.deepEqual([run.matches_inserted, run.llm_accepted, run.pairs_total], [3, 1, 6]);

    const { rows: reasons } = await db.query('SELECT user_id, product_id, decided_by, reason FROM matches ORDER BY user_id, product_id');
    assert.equal(reasons[0].reason, 'CIBIL 800 (min 700), income ₹1,50,000/month (min ₹25,000)');
    assert.equal(reasons[2].reason, "Stable business; O'Brien said $1; ok");

    const { rows: [hits] } = await db.query(buildCacheLookupSql([{ bucket_key: 'inc75000|cs750|Self-Employed|age35', product_id: 2 }, { bucket_key: 'other', product_id: 1 }]));
    assert.deepEqual(hits.hits, [{ bucket_key: 'inc75000|cs750|Self-Employed|age35', product_id: 2, eligible: true, reason: 'Stable business' }]);

    const { rows: [again] } = await db.query(buildPersistSql(args));
    assert.equal(again.matches_inserted, 0, 're-running B must not duplicate matches');
  } finally {
    await db.end();
  }
});

test('persist is a silent no-op for an unknown batch', async () => {
  const db = await freshDb();
  try {
    await seed(db);
    const { rows } = await db.query(buildPersistSql({
      batchId: '00000000-0000-4000-8000-000000000000', startedAt: '2026-10-07T10:00:00Z', stats: {},
      matches: [[U[0], 1, 100, 'rules', null]], newCache: [],
    }));
    assert.equal(rows.length, 0);
    assert.equal((await db.query('SELECT 1 FROM matches')).rows.length, 0);
    assert.equal((await db.query('SELECT 1 FROM match_runs')).rows.length, 0);
  } finally {
    await db.end();
  }
});
