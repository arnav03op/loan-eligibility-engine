// Workflow B › "Verify signature": compare the Crypto node's HMAC with the header,
// check the timestamp window and the batch id.
const { verifyWebhook } = require('../lib/signature');

const { headers = {}, body = {}, expected_signature: expectedSignature, secret_configured: secretConfigured } = $input.first().json;
const result = verifyWebhook({
  expectedSignature,
  signature: headers['x-signature'],
  timestamp: headers['x-timestamp'],
  batchId: body.batch_id,
  secretConfigured,
});

return [{ json: { ...result, batch_id: body.batch_id ?? null, started_at: new Date().toISOString() } }];
