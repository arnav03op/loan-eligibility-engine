// Workflow C › "Build record SQL" (runs once per email): log the SES outcome and,
// when sent, mark that user's matches for this batch as notified.
const { buildRecordSql, extractMessageId } = require('../lib/notify_sql');

const email = $('Loop over emails').item.json;
const error = $json.error ? String($json.error.message ?? $json.error) : null;

return {
  json: {
    user_id: email.user_id,
    sql: buildRecordSql({
      userId: email.user_id,
      batchId: email.batch_id,
      originalEmail: email.original_email,
      recipient: email.recipient,
      status: error ? 'failed' : 'sent',
      messageId: error ? null : extractMessageId($json),
      error,
    }),
  },
};
