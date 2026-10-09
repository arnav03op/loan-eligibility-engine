const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, loadWorkflow, codeOf, runCode, items } = require('./helpers/n8n');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('generated workflow JSON is up to date with n8n/code', () => {
  execFileSync('python3', [path.join(ROOT, 'scripts/build-workflows.py'), '--check'], { stdio: 'pipe' });
});

test('every Code node in every workflow compiles', () => {
  const dir = path.join(ROOT, 'n8n/workflows');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    for (const node of loadWorkflow(file).nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
      assert.doesNotThrow(
        () => new AsyncFunction('$input', '$', '$json', 'require', node.parameters.jsCode),
        `${file} › ${node.name}`,
      );
    }
  }
});

test('runtime-check node runs with bundled libs', async () => {
  const code = codeOf(loadWorkflow('Z_runtime_check.json'), 'Runtime check');
  const out = await runCode(code, {
    $input: items({ expected_hmac: '40a2925fa09fbada925a75e4073463c48a6eb7b2e06eac97acbbbb327a2a117d', gemini_model: 'm', secret_configured: true, test_inbox_count: 2 }),
  });
  assert.deepEqual(out[0].json, {
    bundled_lib_hash_of_abc: 'e71fa2190541574b',
    crypto_node_matches_vector: true,
    gemini_model: 'm',
    webhook_secret_configured: true,
    test_inbox_count: 2,
  });
});

test('Workflow A: Sources and Normalize nodes run bundled', async () => {
  const wf = loadWorkflow('A_product_discovery.json');
  const sources = await runCode(codeOf(wf, 'Sources'), {});
  assert.equal(sources.length, 3);

  const planItem = { source: 'tatacapital', kind: 'lender', lender: 'Tata Capital', url: 'https://t.example', hash: 'h' };
  const gemini = { candidates: [{ content: { parts: [{ text: JSON.stringify([{ lender: 'Tata Capital', product_name: 'Personal Loan', rate_min: 10.99, rate_max: 29.99 }]) }] } }] };
  const out = await runCode(codeOf(wf, 'Normalize & build upsert'), {
    $input: items(gemini),
    $: () => items(planItem),
  });
  assert.equal(out[0].json.outcome, 'ok');
});

test('Workflow B: verify node accepts a valid call and rejects a forged one', async () => {
  const code = codeOf(loadWorkflow('B_user_matching.json'), 'Verify signature');
  const now = Math.floor(Date.now() / 1000);
  const crypto = require('node:crypto');
  const batch = '123e4567-e89b-42d3-a456-426614174000';
  const sig = crypto.createHmac('sha256', 'k').update(`${now}.${batch}`).digest('hex');
  const call = (signature) => runCode(code, { $input: items({
    headers: { 'x-timestamp': String(now), 'x-signature': signature }, body: { batch_id: batch },
    expected_signature: sig, secret_configured: true,
  }) });
  assert.equal((await call(sig))[0].json.valid, true);
  assert.equal((await call('0'.repeat(64)))[0].json.valid, false);
});

test('Workflow B: stage 2 node wires stage 1 and products together', async () => {
  const code = codeOf(loadWorkflow('B_user_matching.json'), 'Stage 2: rules & scoring');
  const nodes = {
    'Build query SQL': items({ batch_id: '5b0c0f4e-3c43-4b4e-9b3a-0d6f2a1c9e11', started_at: '2026-10-07T10:00:00Z' }),
    'Fetch active products': items({ products: [{ product_id: 1, min_monthly_income: 25000, min_credit_score: 700, min_age: 21, max_age: 60, employment_types: ['Salaried'], criteria_source: 'explicit' }] }),
  };
  const out = await runCode(code, {
    $input: items({ users_in_batch: 1, products_active: 1, pairs_total: 1, pairs_after_sql: 1, candidates: [{ user_id: 'u1', monthly_income: 90000, credit_score: 800, employment_status: 'Salaried', age: 30, product_ids: [1] }] }),
    $: (name) => nodes[name],
  });
  assert.deepEqual(out[0].json.accepted, [['u1', 1, 100]]);
  assert.match(out[0].json.cache_sql, /llm_decision_cache/);
});

test('Workflow C: email and record nodes run bundled', async () => {
  const wf = loadWorkflow('C_notification.json');
  const emails = await runCode(codeOf(wf, 'Build emails'), {
    $input: items({ batch_id: '5b0c0f4e-3c43-4b4e-9b3a-0d6f2a1c9e11', users: [{ user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', name: 'Asha', email: 'a@example.com', monthly_income: 50000, credit_score: 750, employment_status: 'Salaried', age: 30, match_count: 1, products: [] }] }),
    $: () => items({ test_inbox_aliases: 'me+one@gmail.com' }),
  });
  assert.equal(emails[0].json.recipient, 'me+one@gmail.com');

  const record = await runCode(codeOf(wf, 'Build record SQL'), {
    $json: { MessageId: 'm-1' },
    $: () => items(emails[0].json),
  });
  assert.match(record.json.sql, /'sent'/);
  assert.match(record.json.sql, /'"m-1"'::json/);
});

test('Workflow E: alert node runs bundled', async () => {
  const out = await runCode(codeOf(loadWorkflow('E_error_handler.json'), 'Format alert'), {
    $input: items({ workflow: { name: 'A' }, execution: { lastNodeExecuted: 'Fetch page', error: { message: 'boom' } } }),
  });
  assert.equal(out[0].json.subject, '[Loan Engine] A failed at Fetch page');
});

test('B only triggers Workflow C through the "Batch persisted?" guard', () => {
  const wf = loadWorkflow('B_user_matching.json');
  const targets = (name, out) => ((wf.connections[name] || {}).main || [])[out] || [];
  const persist = wf.connections['Persist matches & funnel stats'].main;
  assert.deepEqual(persist.flat().map((c) => c.node), ['Batch persisted?']);
  assert.equal(persist.length, 1);
  assert.deepEqual(targets('Batch persisted?', 0).map((c) => c.node), ['Trigger notifications (Workflow C)']);
  assert.deepEqual(targets('Batch persisted?', 1), []);
});
