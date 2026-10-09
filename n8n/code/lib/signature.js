'use strict';
// Webhook authentication for Workflow B. n8n's Crypto node computes the expected
// HMAC-SHA256 of "{timestamp}.{batch_id}" with $env.WEBHOOK_SECRET (so the secret
// never enters Code-node data); this function compares it and checks freshness.

const { UUID_RE } = require('./sql_literal');
const { safeEqual } = require('./format');

const MAX_SKEW_SECONDS = 300;

// Checks the webhook signature and that it's fresh.
function verifyWebhook({ expectedSignature, signature, timestamp, batchId, secretConfigured, now = Math.floor(Date.now() / 1000) }) {
  if (!secretConfigured) return { valid: false, reason: 'webhook secret not configured' };
  if (typeof batchId !== 'string' || !UUID_RE.test(batchId)) return { valid: false, reason: 'missing or invalid batch_id' };
  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) return { valid: false, reason: 'missing or invalid timestamp' };
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) return { valid: false, reason: 'timestamp outside the allowed window' };
  if (!safeEqual(String(signature ?? ''), String(expectedSignature ?? ''))) return { valid: false, reason: 'bad signature' };
  return { valid: true, reason: 'ok' };
}

module.exports = { MAX_SKEW_SECONDS, verifyWebhook };
