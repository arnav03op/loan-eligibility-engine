const test = require('node:test');
const assert = require('node:assert/strict');
const { jsonLiteral, quoteLiteral } = require('../lib/sql_literal');
const { freshDb } = require('./helpers/db');

test('jsonLiteral round-trips tricky text through PostgreSQL', async () => {
  const db = await freshDb();
  try {
    const tricky = "O'Brien <b>costs $1; ok</b> back\\slash ₹ \"quoted\" \n newline";
    const { rows } = await db.query(`SELECT (${jsonLiteral({ r: tricky })})->>'r' AS r, ${quoteLiteral(tricky)} AS q`);
    assert.equal(rows[0].r, tricky);
    assert.equal(rows[0].q, tricky);
  } finally {
    await db.end();
  }
});
