// Workflow C › "Build emails": one personalised email per user, addressed to a test inbox.
const { buildEmails } = require('../lib/email');

const { batch_id: batchId, users } = $input.first().json;
const emails = buildEmails({ users: users ?? [], aliases: $('Config').first().json.test_inbox_aliases, batchId });

return emails.map((json) => ({ json }));
