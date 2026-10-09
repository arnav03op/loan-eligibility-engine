'use strict';
// Stage 2 (rules & scoring) and Stage 3 (LLM on borderline pairs only) of the
// Workflow B funnel. Pure functions: the n8n Code nodes just wire data to them.

const { formatInr } = require('./format');
const { geminiRequest, parseGeminiJson } = require('./gemini');
const { buildPersistSql } = require('./matching_sql');

const ACCEPT_MIN_SCORE = 25;        // explicit criteria, no doubts: below this is too close to the cut-off
const FALLBACK_MIN_SCORE = 50;      // borderline pairs the LLM could not judge are accepted only above this
const INFERRED_COMFORT_SCORE = 50;  // guessed criteria + lower score → ask the LLM
const DEFAULT_TENURE_MONTHS = 60;
const DEFAULT_MAX_CALLS = 20;
const PAIRS_PER_LLM_CALL = 40;
const VINTAGE_RE = /vintage|years? in business|business (?:continuity|stability|existence)|\bitr\b|income tax return/i;

const INCOME_EDGES = [0, 50000, 75000, 100000];
const CREDIT_EDGES = [300, 650, 700, 750, 800];
const AGE_EDGES = [18, 25, 35, 45, 55];

// Keeps a number between 0 and 1.
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// 0-100: half from CIBIL headroom (75 points above the minimum = full marks),
// half from income headroom (twice the minimum income = full marks).
function scorePair(user, product) {
  const credit = clamp01((user.credit_score - product.min_credit_score) / 75);
  const income = clamp01((user.monthly_income - product.min_monthly_income) / product.min_monthly_income);
  return Math.round(50 * credit + 50 * income);
}

// Doubts a numeric filter cannot settle — these are what the LLM is for.
function flagsFor(user, product, score) {
  const flags = [];
  const tenureYears = (product.max_tenure_months ?? DEFAULT_TENURE_MONTHS) / 12;
  if (user.age + tenureYears > product.max_age) flags.push('maturity_age');
  if (user.employment_status !== 'Salaried' && user.age < 25 && VINTAGE_RE.test(product.eligibility_notes ?? '')) {
    flags.push('business_vintage');
  }
  if (product.criteria_source === 'inferred' && score < INFERRED_COMFORT_SCORE) flags.push('inferred_criteria');
  return flags;
}

// Says accept, reject or borderline for a pair.
function classifyPair(user, product) {
  const score = scorePair(user, product);
  const flags = flagsFor(user, product, score);
  // A doubt never rescues a pair the rules would reject — except guessed criteria, where the score itself is unreliable.
  if (score < ACCEPT_MIN_SCORE && !flags.includes('inferred_criteria')) return { decision: 'reject', score, flags };
  if (flags.length) return { decision: 'borderline', score, flags };
  return { decision: score >= ACCEPT_MIN_SCORE ? 'accept' : 'reject', score, flags };
}

// Puts a number into a range group.
function band(value, edges) {
  let index = 0;
  for (let i = 0; i < edges.length; i += 1) if (value >= edges[i]) index = i;
  return { from: edges[index], to: index + 1 < edges.length ? edges[index + 1] - 1 : null };
}

// Users in the same bucket get the same LLM verdict for a product (and share the cache).
function bucketOf(user) {
  const income = band(user.monthly_income, INCOME_EDGES);
  const credit = band(user.credit_score, CREDIT_EDGES);
  const age = band(user.age, AGE_EDGES);
  return {
    key: `inc${income.from}|cs${credit.from}|${user.employment_status}|age${age.from}`,
    income,
    credit,
    age,
    employment_status: user.employment_status,
  };
}

// Makes the cache key for a group and product.
const decisionKey = (bucketKey, productId) => `${bucketKey}#${productId}`;

// Applies the rules to every pair.
function runStage2(stage1, products) {
  const byId = new Map(products.map((p) => [p.product_id, p]));
  const accepted = [];
  const borderline = [];
  const buckets = {};
  let rejected = 0;
  for (const user of stage1.candidates ?? []) {
    let bucket = null;
    for (const productId of user.product_ids) {
      const product = byId.get(productId);
      if (!product) continue;
      const { decision, score, flags } = classifyPair(user, product);
      if (decision === 'accept') {
        accepted.push([user.user_id, productId, score]);
      } else if (decision === 'reject') {
        rejected += 1;
      } else {
        bucket = bucket ?? bucketOf(user);
        // Verdicts depend on the concerns raised, so the key carries them.
        const key = `${bucket.key}|f:${[...flags].sort().join('+')}`;
        buckets[key] = buckets[key] ?? bucket;
        borderline.push({ u: user.user_id, p: productId, s: score, b: key, f: flags });
      }
    }
  }
  const pairs = new Map();
  for (const pair of borderline) {
    const key = decisionKey(pair.b, pair.p);
    const entry = pairs.get(key) ?? { bucket_key: pair.b, product_id: pair.p, flags: [] };
    for (const flag of pair.f) if (!entry.flags.includes(flag)) entry.flags.push(flag);
    pairs.set(key, entry);
  }
  return {
    batch_id: stage1.batch_id,
    started_at: stage1.started_at,
    accepted,
    borderline,
    buckets,
    bucket_pairs: [...pairs.values()],
    stats: {
      users_in_batch: stage1.users_in_batch ?? 0,
      products_active: stage1.products_active ?? 0,
      pairs_total: stage1.pairs_total ?? 0,
      pairs_after_sql: stage1.pairs_after_sql ?? 0,
      rules_accepted: accepted.length,
      rules_rejected: rejected,
      borderline_pairs: borderline.length,
    },
  };
}

const JUDGE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      bucket_key: { type: 'STRING' },
      product_id: { type: 'INTEGER' },
      eligible: { type: 'BOOLEAN' },
      reason: { type: 'STRING' },
    },
    required: ['bucket_key', 'product_id', 'eligible', 'reason'],
  },
};

// Writes a range in plain words.
function describeRange(range, fmt) {
  if (range.to === null) return `${fmt(range.from)} or more`;
  if (range.from === 0) return `up to ${fmt(range.to)}`;
  return `${fmt(range.from)}–${fmt(range.to)}`;
}

// Describes a user group in plain words.
function describeBucket(bucket) {
  return `monthly income ${describeRange(bucket.income, formatInr)}; CIBIL ${describeRange(bucket.credit, String)}; `
    + `${bucket.employment_status}; age ${describeRange(bucket.age, String)}`;
}

// Describes a loan product in plain words.
function describeProduct(p) {
  const parts = [
    `${p.lender} — ${p.product_name}`,
    `${p.rate_min}–${p.rate_max}% p.a.`,
    `min income ${formatInr(p.min_monthly_income)}/month`,
    `min CIBIL ${p.min_credit_score}`,
    `age ${p.min_age}–${p.max_age}`,
    `employment: ${p.employment_types.join(', ')}`,
    `criteria ${p.criteria_source}`,
  ];
  if (p.max_tenure_months) parts.push(`max tenure ${p.max_tenure_months} months`);
  if (p.eligibility_notes) parts.push(`notes: ${p.eligibility_notes}`);
  return parts.join('; ');
}

// Builds the Gemini request for the borderline questions.
function buildJudgeRequest(items, buckets, productsById) {
  const lines = items.map((item) => JSON.stringify({
    bucket_key: item.bucket_key,
    product_id: item.product_id,
    profile: describeBucket(buckets[item.bucket_key]),
    product: describeProduct(productsById.get(item.product_id)),
    flags: item.flags,
  }));
  const prompt = [
    'You are a credit analyst for Indian personal loans. Each item pairs an applicant PROFILE BUCKET with a loan PRODUCT.',
    "Every applicant in the bucket already meets the product's numeric minimums (income, CIBIL, age, employment type).",
    'A rules engine flagged each pair for the listed concerns. Decide whether a typical applicant from the bucket is LIKELY to be approved. Be conservative.',
    '',
    'Flag meanings:',
    "- maturity_age: the applicant may pass the lender's maximum age before the loan tenure ends.",
    '- business_vintage: a young self-employed or business applicant, while the lender requires years of business history.',
    '- inferred_criteria: the lender did not publish criteria; they were estimated, and the applicant is close to the estimates.',
    '',
    'Return exactly one result per item, echoing bucket_key and product_id, with eligible true/false and a reason of at most 20 words.',
    '',
    'Items (one JSON object per line):',
    ...lines,
  ].join('\n');
  return geminiRequest(prompt, JUDGE_SCHEMA);
}

// Combines rule and AI results into the final matches.
function finalize(stage2, stats, decisions, freshDecisions) {
  const all = { ...decisions, ...freshDecisions };
  const matches = stage2.accepted.map(([u, p, s]) => [u, p, s, 'rules', null]);
  for (const pair of stage2.borderline) {
    const decision = all[decisionKey(pair.b, pair.p)];
    if (decision) {
      if (decision.eligible) matches.push([pair.u, pair.p, pair.s, 'llm', decision.reason]);
    } else if (pair.s >= FALLBACK_MIN_SCORE) {
      matches.push([pair.u, pair.p, pair.s, 'rules', null]);
    }
  }
  const newCache = Object.entries(freshDecisions).map(([key, d]) => {
    const split = key.lastIndexOf('#');
    return { bucket_key: key.slice(0, split), product_id: Number(key.slice(split + 1)), eligible: d.eligible, reason: d.reason };
  });
  return buildPersistSql({ batchId: stage2.batch_id, startedAt: stage2.started_at, stats, matches, newCache });
}

// Works out which questions need Gemini and splits them into calls.
function planLlmWork({ stage2, products, hits, maxCalls }) {
  const cached = {};
  for (const hit of hits ?? []) cached[decisionKey(hit.bucket_key, hit.product_id)] = { eligible: hit.eligible, reason: hit.reason };
  const byId = new Map(products.map((p) => [p.product_id, p]));
  const pending = stage2.bucket_pairs.filter((p) => !(decisionKey(p.bucket_key, p.product_id) in cached) && byId.has(p.product_id));

  const limit = Number.isFinite(maxCalls) && maxCalls >= 0 ? Math.floor(maxCalls) : DEFAULT_MAX_CALLS;
  const llmBatches = [];
  for (let i = 0; i < pending.length && llmBatches.length < limit; i += PAIRS_PER_LLM_CALL) {
    const chunk = pending.slice(i, i + PAIRS_PER_LLM_CALL);
    llmBatches.push({
      keys: chunk.map((p) => decisionKey(p.bucket_key, p.product_id)),
      gemini_request: buildJudgeRequest(chunk, stage2.buckets, byId),
    });
  }

  const stats = {
    ...stage2.stats,
    llm_buckets: stage2.bucket_pairs.length,
    llm_cache_hits: stage2.bucket_pairs.length - pending.length,
    llm_calls: llmBatches.length,
  };
  const plan = { batch_id: stage2.batch_id, needs_llm: llmBatches.length > 0, llm_batches: llmBatches, cached, stats };
  if (!plan.needs_llm) plan.persist_sql = finalize(stage2, stats, cached, {});
  return plan;
}

// Applies Gemini's answers to the borderline pairs.
function applyLlmDecisions({ stage2, plan, responses }) {
  const requested = new Set(plan.llm_batches.flatMap((batch) => batch.keys));
  const fresh = {};
  let failedCalls = 0;
  for (const response of responses) {
    let results;
    try {
      if (response?.error) throw new Error('request failed');
      results = parseGeminiJson(response);
    } catch (err) {
      failedCalls += 1;
      continue;
    }
    for (const r of Array.isArray(results) ? results : []) {
      const key = decisionKey(r?.bucket_key, r?.product_id);
      if (!requested.has(key) || typeof r.eligible !== 'boolean') continue;
      fresh[key] = { eligible: r.eligible, reason: String(r.reason ?? '').slice(0, 300) || 'Judged by LLM' };
    }
  }
  return {
    decided_by_llm: Object.keys(fresh).length,
    failed_llm_calls: failedCalls,
    persist_sql: finalize(stage2, plan.stats, plan.cached, fresh),
  };
}

module.exports = { scorePair, classifyPair, bucketOf, runStage2, planLlmWork, applyLlmDecisions };
