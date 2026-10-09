const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers/db');
const { normalizeProducts } = require('../lib/products');
const { buildCrawlStateSql, buildCrawlStatusSql, buildUnchangedSql, buildUpsertProductsSql } = require('../lib/crawl_sql');

const LENDER = { source: 'tatacapital', kind: 'lender', lender: 'Tata Capital', url: 'https://tata.example', hash: 'h1' };
const AGG = { source: 'bankbazaar', kind: 'aggregator', lender: null, url: 'https://bb.example', hash: 'h9' };
const product = (overrides = {}) => ({
  lender: 'Tata Capital', product_name: 'Personal Loan', rate_min: 10.99, rate_max: 29.99,
  min_monthly_income: 15000, min_credit_score: 700, min_age: 22, max_age: 58, employment_types: ['Salaried'],
  ...overrides,
});

async function run(db, sql) {
  const { rows } = await db.query(sql);
  assert.equal(rows.length, 1, 'every builder returns exactly one row');
  return rows[0];
}

test('upsert inserts products and records the crawl', async () => {
  const db = await freshDb();
  try {
    const products = normalizeProducts([product(), product({ product_name: 'Express Loan', min_credit_score: 750 })], LENDER);
    const row = await run(db, buildUpsertProductsSql(LENDER, products));
    assert.deepEqual([row.status, row.products_upserted, row.products_deactivated], ['ok', 2, 0]);
    const { rows } = await db.query("SELECT product_name, employment_types, criteria_source FROM loan_products ORDER BY product_name");
    assert.deepEqual(rows, [
      { product_name: 'Express Loan', employment_types: ['Salaried'], criteria_source: 'explicit' },
      { product_name: 'Personal Loan', employment_types: ['Salaried'], criteria_source: 'explicit' },
    ]);
    const state = await run(db, buildCrawlStateSql([LENDER.url, 'https://never.example']));
    assert.deepEqual(state.state, [{ url: LENDER.url, last_hash: 'h1' }]);
  } finally {
    await db.end();
  }
});

test('re-crawl deactivates vanished products and invalidates cache only for changed criteria', async () => {
  const db = await freshDb();
  try {
    await run(db, buildUpsertProductsSql(LENDER, normalizeProducts([product(), product({ product_name: 'Express Loan' }), product({ product_name: 'Old Loan' })], LENDER)));
    const ids = Object.fromEntries((await db.query('SELECT product_name, product_id FROM loan_products')).rows.map((r) => [r.product_name, r.product_id]));
    await db.query(`INSERT INTO llm_decision_cache (bucket_key, product_id, eligible, reason) VALUES
      ('b', ${ids['Personal Loan']}, true, 'r'), ('b', ${ids['Express Loan']}, true, 'r')`);

    const second = normalizeProducts([product(), product({ product_name: 'Express Loan', min_credit_score: 760 })], LENDER);
    const row = await run(db, buildUpsertProductsSql({ ...LENDER, hash: 'h2' }, second));
    assert.deepEqual([row.products_upserted, row.products_deactivated, row.products_cache_invalidated], [2, 1, 1]);

    const active = (await db.query('SELECT product_name FROM loan_products WHERE is_active ORDER BY 1')).rows.map((r) => r.product_name);
    assert.deepEqual(active, ['Express Loan', 'Personal Loan']);
    const cached = (await db.query('SELECT product_id FROM llm_decision_cache')).rows.map((r) => r.product_id);
    assert.deepEqual(cached, [ids['Personal Loan']]);
  } finally {
    await db.end();
  }
});

test('aggregator guesses never overwrite a lender\'s explicit criteria', async () => {
  const db = await freshDb();
  try {
    await run(db, buildUpsertProductsSql(LENDER, normalizeProducts([product()], LENDER)));
    const guessed = normalizeProducts([{ lender: 'Tata Capital', product_name: 'Personal Loan', rate_min: 11, rate_max: 11 }], AGG);
    assert.equal(guessed[0].criteria_source, 'inferred');
    await run(db, buildUpsertProductsSql(AGG, guessed));
    const { rows } = await db.query('SELECT source, min_credit_score, criteria_source FROM loan_products');
    assert.deepEqual(rows, [{ source: 'tatacapital', min_credit_score: 700, criteria_source: 'explicit' }]);
  } finally {
    await db.end();
  }
});

test('failed crawl keeps the last hash; unchanged crawl touches products', async () => {
  const db = await freshDb();
  try {
    await run(db, buildUpsertProductsSql(LENDER, normalizeProducts([product()], LENDER)));
    const failed = await run(db, buildCrawlStatusSql(LENDER, 'failed', "HTTP 403 'blocked'"));
    assert.equal(failed.status, 'failed');
    const { rows: [src] } = await db.query('SELECT last_hash, last_error FROM crawl_sources');
    assert.deepEqual(src, { last_hash: 'h1', last_error: "HTTP 403 'blocked'" });

    const unchanged = await run(db, buildUnchangedSql(LENDER));
    assert.deepEqual([unchanged.status, unchanged.products_touched], ['unchanged', 1]);
  } finally {
    await db.end();
  }
});

test('an aggregator with fully explicit criteria still cannot touch a lender-owned product', async () => {
  const db = await freshDb();
  try {
    await run(db, buildUpsertProductsSql(LENDER, normalizeProducts([product()], LENDER)));
    const full = normalizeProducts([product({ min_credit_score: 650 })], AGG);
    assert.equal(full[0].criteria_source, 'explicit');
    await run(db, buildUpsertProductsSql(AGG, full));
    const { rows } = await db.query('SELECT source, min_credit_score FROM loan_products');
    assert.deepEqual(rows, [{ source: 'tatacapital', min_credit_score: 700 }]);
  } finally {
    await db.end();
  }
});

test('a lender page takes over a product first inserted by the aggregator', async () => {
  const db = await freshDb();
  try {
    await run(db, buildUpsertProductsSql(AGG, normalizeProducts([product()], AGG)));
    await run(db, buildUpsertProductsSql(LENDER, normalizeProducts([product({ min_credit_score: 650 })], LENDER)));
    const { rows } = await db.query('SELECT source, min_credit_score FROM loan_products');
    assert.deepEqual(rows, [{ source: 'tatacapital', min_credit_score: 650 }]);
  } finally {
    await db.end();
  }
});
