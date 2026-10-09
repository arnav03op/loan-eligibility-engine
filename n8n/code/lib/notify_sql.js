'use strict';
// SQL for Workflow C: who to email (with their best matches) and the send log.

const { quoteLiteral, textLiteral, uuidLiteral, intLiteral } = require('./sql_literal');

const SES_SANDBOX_DAILY_LIMIT = 200;
const TOP_PRODUCTS = 5;

// batchId null → the most recently completed batch (manual runs).
function buildPendingSql(batchId, cap) {
  const limit = Number.isInteger(cap) && cap >= 0 ? Math.min(cap, SES_SANDBOX_DAILY_LIMIT) : 5;
  const target = batchId
    ? `SELECT ${uuidLiteral(batchId)} AS batch_id`
    : "SELECT batch_id FROM upload_batches WHERE status = 'completed' ORDER BY completed_at DESC NULLS LAST LIMIT 1";
  return `WITH target AS (
  ${target}
), pending AS (
  SELECT u.user_id, u.name, u.email, u.monthly_income, u.credit_score, u.employment_status, u.age,
         count(*)::int AS match_count
  FROM matches m
  JOIN target t ON m.batch_id = t.batch_id
  JOIN users u ON u.user_id = m.user_id
  WHERE m.notified_at IS NULL
  GROUP BY u.user_id
  ORDER BY count(*) DESC, u.user_id
  LIMIT ${intLiteral(limit)}
)
SELECT (SELECT batch_id FROM target) AS batch_id,
  coalesce((SELECT json_agg(json_build_object(
      'user_id', p.user_id, 'name', p.name, 'email', p.email, 'monthly_income', p.monthly_income,
      'credit_score', p.credit_score, 'employment_status', p.employment_status, 'age', p.age,
      'match_count', p.match_count,
      'products', (SELECT json_agg(x) FROM (
          SELECT lp.lender, lp.product_name, lp.rate_min, lp.rate_max, lp.source_url, m.score, m.reason
          FROM matches m
          JOIN loan_products lp ON lp.product_id = m.product_id
          JOIN target t ON m.batch_id = t.batch_id
          WHERE m.user_id = p.user_id AND m.notified_at IS NULL
          ORDER BY m.score DESC, lp.rate_min ASC, lp.product_id
          LIMIT ${TOP_PRODUCTS}) x)
    ) ORDER BY p.match_count DESC, p.user_id) FROM pending p), '[]'::json) AS users`;
}

// SQL to record that an email was sent or failed.
function buildRecordSql({ userId, batchId, originalEmail, recipient, status, messageId, error }) {
  if (status !== 'sent' && status !== 'failed') throw new Error(`invalid status: ${status}`);
  // Writes a value as SQL text, or NULL if empty.
  const nullable = (value) => (value === null || value === undefined ? 'NULL' : textLiteral(value));
  const user = uuidLiteral(userId);
  const batch = uuidLiteral(batchId);
  const mark = status === 'sent'
    ? `UPDATE matches SET notified_at = now() WHERE user_id = ${user} AND batch_id = ${batch} AND notified_at IS NULL RETURNING 1`
    : 'SELECT 1 WHERE false';
  return `WITH n AS (
  INSERT INTO notifications (user_id, batch_id, original_email, recipient, status, ses_message_id, error)
  VALUES (${user}, ${batch}, ${textLiteral(originalEmail)}, ${textLiteral(recipient)}, ${quoteLiteral(status)},
          ${nullable(messageId)}, ${nullable(error ? String(error).slice(0, 1000) : null)})
  RETURNING id, status
), marked AS (
  ${mark}
)
SELECT (SELECT id FROM n) AS notification_id, (SELECT status FROM n) AS status,
       (SELECT count(*) FROM marked)::int AS matches_marked`;
}

// The SES node's response shape differs between n8n versions; search it.
function extractMessageId(sesJson) {
  const match = JSON.stringify(sesJson ?? {}).match(/"MessageId"\s*:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

module.exports = { buildPendingSql, buildRecordSql, extractMessageId };
