// Workflow C › "Build pending SQL": users of this batch with un-notified matches
// (no batch_id on manual runs → the latest completed batch), capped by NOTIFY_MAX_EMAILS.
const { buildPendingSql } = require('../lib/notify_sql');

const { batch_id: batchId, notify_max_emails: cap } = $input.first().json;

return [{ json: { sql: buildPendingSql(batchId ?? null, Number(cap)) } }];
