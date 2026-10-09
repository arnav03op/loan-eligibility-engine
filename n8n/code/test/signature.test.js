const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyWebhook } = require('../lib/signature');

const BATCH = '123e4567-e89b-42d3-a456-426614174000';
const VECTOR = '40a2925fa09fbada925a75e4073463c48a6eb7b2e06eac97acbbbb327a2a117d';

test('Node HMAC agrees with the shared Python vector', () => {
  assert.equal(crypto.createHmac('sha256', 's3cr3t').update(`1700000000.${BATCH}`).digest('hex'), VECTOR);
});

const base = { expectedSignature: VECTOR, signature: VECTOR, timestamp: '1700000000', batchId: BATCH, secretConfigured: true, now: 1700000100 };

test('accepts a fresh, correctly signed request', () => {
  assert.deepEqual(verifyWebhook(base), { valid: true, reason: 'ok' });
});

test('rejects every kind of bad request with a reason', () => {
  const cases = [
    [{ secretConfigured: false }, /not configured/],
    [{ batchId: 'nope' }, /batch_id/],
    [{ timestamp: undefined }, /timestamp/],
    [{ now: 1700000000 + 301 }, /window/],
    [{ now: 1700000000 - 301 }, /window/],
    [{ signature: VECTOR.replace('4', '5') }, /signature/],
    [{ signature: undefined }, /signature/],
  ];
  for (const [override, reason] of cases) {
    const result = verifyWebhook({ ...base, ...override });
    assert.equal(result.valid, false, JSON.stringify(override));
    assert.match(result.reason, reason);
  }
});
