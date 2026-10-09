// Test-only helper: a wiped, migrated loan_engine_test database (the dev-db container).
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const URL = process.env.TEST_DATABASE_URL ?? 'postgresql://loan:loan@localhost:55432/loan_engine_test';
const MIGRATIONS = path.resolve(__dirname, '../../../../db/migrations');

async function freshDb() {
  const client = new Client({ connectionString: URL });
  await client.connect();
  const { rows } = await client.query('SELECT current_database() AS name');
  if (!rows[0].name.endsWith('_test')) {
    await client.end();
    throw new Error(`refusing to wipe non-test database: ${rows[0].name}`);
  }
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    await client.query(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }
  return client;
}

module.exports = { freshDb };
