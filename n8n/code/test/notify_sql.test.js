const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers/db');
const { buildPendingSql, buildRecordSql } = require('../lib/notify_sql');

const BATCH = '5b0c0f4e-3c43-4b4e-9b3a-0d6f2a1c9e11';
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const U2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

async function seed(db) {
  await db.query(`INSERT INTO upload_batches (batch_id, s3_key, status, completed_at) VALUES ('${BATCH}', 'k', 'completed', now())`);
  await db.query(`INSERT INTO users (user_id, name, email, monthly_income, credit_score, employment_status, age, batch_id) VALUES
    ('${U1}', 'Asha', 'a@example.com', 85000, 760, 'Salaried', 31, '${BATCH}'),
    ('${U2}', 'Ravi', 'r@example.com', 40000, 710, 'Business', 44, '${BATCH}')`);
  for (let id = 1; id <= 7; id += 1) {
    await db.query(`INSERT INTO loan_products (product_id, source, lender, product_name, rate_min, rate_max, min_monthly_income,
        min_credit_score, min_age, max_age, employment_types, criteria_source, criteria_hash, source_url)
      VALUES (${id}, 's', 'Lender ${id}', 'Loan ${id}', ${10 + id}, 30, 25000, 700, 21, 60, ARRAY['Salaried'], 'explicit', 'h', 'https://x/${id}')`);
    await db.query(`INSERT INTO matches (user_id, product_id, batch_id, decided_by, score, reason)
      VALUES ('${U1}', ${id}, '${BATCH}', 'rules', ${id * 10}, 'r${id}')`);
  }
  await db.query(`INSERT INTO matches (user_id, product_id, batch_id, decided_by, score, reason) VALUES ('${U2}', 1, '${BATCH}', 'llm', 40, 'ok')`);
}

test('pending users come with their top 5 matches, capped and ordered', async () => {
  const db = await freshDb();
  try {
    await seed(db);
    const { rows: [all] } = await db.query(buildPendingSql(BATCH, 5));
    assert.equal(all.batch_id, BATCH);
    assert.deepEqual(all.users.map((u) => [u.user_id, u.match_count]), [[U1, 7], [U2, 1]]);
    assert.deepEqual(all.users[0].products.map((p) => p.score), [70, 60, 50, 40, 30]);

    const { rows: [capped] } = await db.query(buildPendingSql(BATCH, 1));
    assert.equal(capped.users.length, 1);

    const { rows: [latest] } = await db.query(buildPendingSql(null, 5));
    assert.equal(latest.batch_id, BATCH, 'manual runs default to the latest completed batch');
  } finally {
    await db.end();
  }
});

test('recording a sent email marks matches; a failure does not', async () => {
  const db = await freshDb();
  try {
    await seed(db);
    const sent = (await db.query(buildRecordSql({ userId: U1, batchId: BATCH, originalEmail: 'a@example.com', recipient: 'me+one@gmail.com', status: 'sent', messageId: 'm-1', error: null }))).rows[0];
    assert.deepEqual([sent.status, sent.matches_marked], ['sent', 7]);
    const failed = (await db.query(buildRecordSql({ userId: U2, batchId: BATCH, originalEmail: 'r@example.com', recipient: 'me+two@gmail.com', status: 'failed', messageId: null, error: "Throttling: 'rate'" }))).rows[0];
    assert.deepEqual([failed.status, failed.matches_marked], ['failed', 0]);

    const { rows: [pending] } = await db.query(buildPendingSql(BATCH, 5));
    assert.deepEqual(pending.users.map((u) => u.user_id), [U2], 'failed sends stay pending for a retry');
    assert.throws(() => buildRecordSql({ userId: 'bad', batchId: BATCH, originalEmail: 'x', recipient: 'y', status: 'sent' }), /invalid uuid/);
    assert.throws(() => buildRecordSql({ userId: U1, batchId: BATCH, originalEmail: 'x', recipient: 'y', status: 'maybe' }), /invalid status/);
  } finally {
    await db.end();
  }
});

test('recorded addresses and errors round-trip unchanged, with no $ or ; reaching n8n', async () => {
  // The n8n Postgres node formats the query text before sending it, so data must
  // never put a "$1"-style token or a statement separator into the SQL.
  const db = await freshDb();
  try {
    await seed(db);
    const tricky = { originalEmail: 'a$1;b@example.com', recipient: "me+$2;'x'@gmail.com", error: 'boom $1; DROP TABLE users' };
    const sql = buildRecordSql({ userId: U2, batchId: BATCH, status: 'failed', messageId: 'id$3;', ...tricky });
    assert.doesNotMatch(sql, /[$;]/);
    await db.query(sql);
    const { rows: [row] } = await db.query(`SELECT original_email, recipient, error, ses_message_id FROM notifications WHERE user_id = '${U2}'`);
    assert.deepEqual(row, { original_email: tricky.originalEmail, recipient: tricky.recipient, error: tricky.error, ses_message_id: 'id$3;' });
    assert.throws(() => buildRecordSql({ userId: U2, batchId: BATCH, originalEmail: 'a\u0000b', recipient: 'y', status: 'sent' }), /NUL/);
  } finally {
    await db.end();
  }
});
