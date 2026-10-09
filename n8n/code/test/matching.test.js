const test = require('node:test');
const assert = require('node:assert/strict');
const { scorePair, classifyPair, bucketOf, runStage2, planLlmWork, applyLlmDecisions } = require('../lib/matching');

const product = (overrides = {}) => ({
  product_id: 1, lender: 'Tata Capital', product_name: 'Personal Loan', rate_min: 10.99, rate_max: 29.99,
  min_monthly_income: 25000, min_credit_score: 700, min_age: 21, max_age: 60,
  employment_types: ['Salaried', 'Self-Employed', 'Business'], max_tenure_months: 60,
  eligibility_notes: null, criteria_source: 'explicit', ...overrides,
});
const user = (overrides = {}) => ({
  user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', monthly_income: 50000, credit_score: 775,
  employment_status: 'Salaried', age: 30, ...overrides,
});

test('scorePair rewards headroom above the minimums', () => {
  assert.equal(scorePair(user({ credit_score: 700, monthly_income: 25000 }), product()), 0);
  assert.equal(scorePair(user({ credit_score: 775, monthly_income: 50000 }), product()), 100);
  assert.equal(scorePair(user({ credit_score: 737.5, monthly_income: 37500 }), product()), 50);
});

test('classifyPair accepts comfortable pairs and rejects razor-thin ones', () => {
  assert.equal(classifyPair(user(), product()).decision, 'accept');
  assert.equal(classifyPair(user({ credit_score: 705, monthly_income: 26000 }), product()).decision, 'reject');
});

test('a doubt never rescues a pair the rules would reject', () => {
  const r = classifyPair(user({ age: 57, credit_score: 705, monthly_income: 26000 }), product({ max_age: 60 }));
  assert.equal(r.decision, 'reject');
});

test('classifyPair flags qualitative doubts as borderline', () => {
  const old = classifyPair(user({ age: 57 }), product({ max_age: 60 }));
  assert.deepEqual([old.decision, old.flags], ['borderline', ['maturity_age']]);

  const young = classifyPair(user({ age: 23, employment_status: 'Business' }), product({ eligibility_notes: 'Minimum 3 years business vintage' }));
  assert.deepEqual(young.flags, ['business_vintage']);

  const guessed = classifyPair(user({ credit_score: 720, monthly_income: 30000 }), product({ criteria_source: 'inferred' }));
  assert.deepEqual(guessed.flags, ['inferred_criteria']);
  assert.equal(classifyPair(user(), product({ criteria_source: 'inferred' })).decision, 'accept', 'comfortable even on guessed criteria');
});

test('bucketOf groups similar profiles under one key', () => {
  const a = bucketOf(user({ monthly_income: 52000, credit_score: 712, age: 26 }));
  const b = bucketOf(user({ monthly_income: 74000, credit_score: 749, age: 34 }));
  assert.equal(a.key, b.key);
  assert.equal(a.key, 'inc50000|cs700|Salaried|age25');
  assert.deepEqual([a.income, a.credit, a.age], [{ from: 50000, to: 74999 }, { from: 700, to: 749 }, { from: 25, to: 34 }]);
  assert.deepEqual(bucketOf(user({ monthly_income: 150000 })).income, { from: 100000, to: null });
});

const stage1 = {
  batch_id: '5b0c0f4e-3c43-4b4e-9b3a-0d6f2a1c9e11', started_at: '2026-10-07T10:00:00.000Z',
  users_in_batch: 3, products_active: 2, pairs_total: 6, pairs_after_sql: 5,
  candidates: [
    { ...user({ user_id: 'u1' }), product_ids: [1, 2] },
    { ...user({ user_id: 'u2', credit_score: 705, monthly_income: 26000 }), product_ids: [1] },
    { ...user({ user_id: 'u3', credit_score: 730, monthly_income: 30000 }), product_ids: [1, 2] },
  ],
};
const products = [product(), product({ product_id: 2, lender: 'HDFC Bank', product_name: 'HDFC Bank Personal Loan', criteria_source: 'inferred' })];

test('runStage2 splits pairs and dedupes borderline work into bucket pairs', () => {
  const s = runStage2(stage1, products);
  assert.deepEqual(s.accepted, [['u1', 1, 100], ['u1', 2, 100], ['u3', 1, 30]]);
  assert.equal(s.borderline.length, 1);
  assert.deepEqual(s.borderline[0], { u: 'u3', p: 2, s: 30, b: 'inc0|cs700|Salaried|age25|f:inferred_criteria', f: ['inferred_criteria'] });
  assert.deepEqual(s.bucket_pairs, [{ bucket_key: 'inc0|cs700|Salaried|age25|f:inferred_criteria', product_id: 2, flags: ['inferred_criteria'] }]);
  assert.deepEqual(s.stats, {
    users_in_batch: 3, products_active: 2, pairs_total: 6, pairs_after_sql: 5,
    rules_accepted: 3, rules_rejected: 1, borderline_pairs: 1,
  });
  assert.equal(s.batch_id, stage1.batch_id);
});

test('planLlmWork uses the cache and batches the rest', () => {
  const s = runStage2(stage1, products);
  const cachedPlan = planLlmWork({ stage2: s, products, hits: [{ bucket_key: 'inc0|cs700|Salaried|age25|f:inferred_criteria', product_id: 2, eligible: true, reason: 'cached' }], maxCalls: 20 });
  assert.equal(cachedPlan.needs_llm, false);
  assert.equal(cachedPlan.stats.llm_cache_hits, 1);
  assert.match(cachedPlan.persist_sql, /INSERT INTO matches/);

  const freshPlan = planLlmWork({ stage2: s, products, hits: [], maxCalls: 20 });
  assert.equal(freshPlan.needs_llm, true);
  assert.equal(freshPlan.llm_batches.length, 1);
  assert.deepEqual(freshPlan.llm_batches[0].keys, ['inc0|cs700|Salaried|age25|f:inferred_criteria#2']);
  const prompt = freshPlan.llm_batches[0].gemini_request.contents[0].parts[0].text;
  assert.ok(prompt.includes('HDFC Bank') && prompt.includes('inferred_criteria'));
  assert.deepEqual(freshPlan.stats.llm_calls, 1);
});

test('planLlmWork respects the call cap and an invalid cap means the default', () => {
  const many = {
    ...runStage2(stage1, products),
    bucket_pairs: Array.from({ length: 100 }, (_, i) => ({ bucket_key: `k${i}`, product_id: 2, flags: ['inferred_criteria'] })),
    buckets: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, bucketOf(user())])),
  };
  assert.equal(planLlmWork({ stage2: many, products, hits: [], maxCalls: 2 }).llm_batches.length, 2);
  assert.equal(planLlmWork({ stage2: many, products, hits: [], maxCalls: Number('abc') }).llm_batches.length, 3);
});

test('applyLlmDecisions trusts only requested keys and falls back by score', () => {
  const s = runStage2(stage1, products);
  const plan = planLlmWork({ stage2: s, products, hits: [], maxCalls: 20 });
  const answer = (results) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(results) }] } }] });

  const yes = applyLlmDecisions({ stage2: s, plan, responses: [answer([
    { bucket_key: 'inc0|cs700|Salaried|age25|f:inferred_criteria', product_id: 2, eligible: true, reason: 'Stable salary' },
    { bucket_key: 'not-requested', product_id: 9, eligible: true, reason: 'ignored' },
  ])] });
  assert.equal(yes.decided_by_llm, 1);
  assert.match(yes.persist_sql, /Stable salary/);
  assert.ok(!yes.persist_sql.includes('ignored'));

  const failed = applyLlmDecisions({ stage2: s, plan, responses: [{ error: { message: 'HTTP 429' } }] });
  assert.equal(failed.failed_llm_calls, 1);
  assert.ok(!failed.persist_sql.includes('"u3",2'), 'score 30 < 50 fallback threshold → not matched');
});
