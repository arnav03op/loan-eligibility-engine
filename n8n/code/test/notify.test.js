const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAliases, buildEmails } = require('../lib/email');
const { extractMessageId } = require('../lib/notify_sql');
const { buildAlert } = require('../lib/alert');

const user = (overrides = {}) => ({
  user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', name: 'Asha Rao', email: 'asha.rao@example.com',
  monthly_income: 85000, credit_score: 760, employment_status: 'Salaried', age: 31, match_count: 7,
  products: [
    { lender: 'Tata Capital', product_name: 'Personal Loan', rate_min: 10.99, rate_max: 29.99, source_url: 'https://www.tatacapital.com/personal-loan.html', score: 90, reason: 'CIBIL 760 (min 700)' },
  ],
  ...overrides,
});

test('parseAliases keeps valid addresses and refuses an empty list', () => {
  assert.deepEqual(parseAliases(' me+one@gmail.com, bad , me+two@gmail.com '), ['me+one@gmail.com', 'me+two@gmail.com']);
  assert.throws(() => parseAliases(''), /TEST_INBOX_ALIASES/);
  assert.throws(() => parseAliases(undefined), /TEST_INBOX_ALIASES/);
});

test('buildEmails rotates test inboxes and never addresses the CSV email', () => {
  const emails = buildEmails({ users: [user(), user(), user()], aliases: 'me+one@gmail.com,me+two@gmail.com', batchId: 'b' });
  assert.deepEqual(emails.map((e) => e.recipient), ['me+one@gmail.com', 'me+two@gmail.com', 'me+one@gmail.com']);
  for (const e of emails) {
    assert.notEqual(e.recipient, 'asha.rao@example.com');
    assert.equal(e.original_email, 'asha.rao@example.com');
  }
});

test('buildEmails personalises subject and body', () => {
  const [email] = buildEmails({ users: [user()], aliases: 'me+one@gmail.com', batchId: 'batch-1' });
  assert.equal(email.subject, 'Asha, you may qualify for 7 personal loans');
  assert.ok(email.html.includes('₹85,000'));
  assert.ok(email.html.includes('10.99%–29.99% p.a.'));
  assert.ok(email.html.includes('…and 6 more matching products.'));
  assert.ok(email.html.includes('href="https://www.tatacapital.com/personal-loan.html"'));
});

test('buildEmails escapes HTML in user and product fields', () => {
  const [email] = buildEmails({
    users: [user({
      name: "O'Brien <script>alert(1)</script>",
      products: [{ lender: '<b>L</b>', product_name: 'P', rate_min: 11, rate_max: 11, source_url: 'javascript:alert(1)', score: 50, reason: '"quoted" & <i>x</i>' }],
      match_count: 1,
    })],
    aliases: 'me@gmail.com',
    batchId: 'b',
  });
  assert.ok(!email.html.includes('<script>'));
  assert.ok(email.html.includes('O&#39;Brien'));
  assert.ok(email.html.includes('&lt;b&gt;L&lt;/b&gt;'));
  assert.ok(email.html.includes('&quot;quoted&quot; &amp; &lt;i&gt;x&lt;/i&gt;'));
  assert.ok(!email.html.includes('javascript:'), 'unsafe URLs are not linked');
  assert.ok(email.html.includes('11% p.a.'));
  assert.equal(email.subject, "O'Brien, you may qualify for 1 personal loan");
});

test('extractMessageId finds the id in any SES response shape', () => {
  assert.equal(extractMessageId({ MessageId: 'abc-1' }), 'abc-1');
  assert.equal(extractMessageId({ SendEmailResponse: { SendEmailResult: { MessageId: 'abc-2' } } }), 'abc-2');
  assert.equal(extractMessageId({}), null);
});

test('buildAlert summarises an n8n error event safely', () => {
  const alert = buildAlert({
    workflow: { name: 'B · User-Loan Matching' },
    execution: { url: 'http://localhost:5678/workflow/x/executions/9', lastNodeExecuted: 'Stage 1: SQL pre-filter', error: { message: 'connection <refused>' } },
  });
  assert.equal(alert.subject, '[Loan Engine] B · User-Loan Matching failed at Stage 1: SQL pre-filter');
  assert.ok(alert.html.includes('connection &lt;refused&gt;'));
  assert.ok(alert.html.includes('href="http://localhost:5678/workflow/x/executions/9"'));
  assert.equal(buildAlert({}).subject, '[Loan Engine] Unknown workflow failed at unknown node');
});
