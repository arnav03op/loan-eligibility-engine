const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanHtml } = require('../lib/clean_html');
const { SOURCES, DEFAULTS, normalizeProducts, buildExtractionRequest } = require('../lib/products');
const { preparePage, planCrawl, pageResult } = require('../lib/crawl');

const LENDER_PAGE = { source: 'tatacapital', kind: 'lender', lender: 'Tata Capital', url: 'https://www.tatacapital.com/personal-loan.html' };
const AGGREGATOR = { source: 'bankbazaar', kind: 'aggregator', lender: null, url: 'https://www.bankbazaar.com/personal-loan.html' };

const HTML = `<html><head><title>x</title><script>var interest = 1;</script></head><body>
<nav>Home | Credit Cards | Business Loans</nav>
<h2>Personal Loan Interest Rates</h2>
<table><tr><th>Bank</th><th>Interest Rate</th></tr><tr><td>HDFC Bank</td><td>10.90% p.a. onwards</td></tr></table>
<p>Minimum net monthly income of &#8377;25,000 &amp; CIBIL score of 750.</p>
<p>Lorem ipsum dolor sit amet.</p>
<p>Quisque at ligula.</p>
<p>Unrelated footer text.</p>
<!-- interest comment -->
</body></html>`;

const geminiOk = (products) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(products) }] } }] });

test('cleanHtml keeps eligibility lines and drops scripts, nav and noise', () => {
  const text = cleanHtml(HTML);
  assert.ok(text.includes('HDFC Bank | 10.90% p.a. onwards'));
  assert.ok(text.includes('Minimum net monthly income of ₹25,000 & CIBIL score of 750.'));
  assert.ok(text.includes('Lorem ipsum dolor sit amet.'), 'one line of context is kept');
  for (const gone of ['var interest', 'Credit Cards', 'Quisque', 'Unrelated footer', 'interest comment']) {
    assert.ok(!text.includes(gone), `should drop: ${gone}`);
  }
});

test('cleanHtml respects maxChars', () => {
  const big = '<p>Interest rate 10%</p>'.repeat(5000).replace(/10%/g, () => `${Math.random()}%`);
  assert.ok(cleanHtml(big, { maxChars: 500 }).length <= 500);
});

test('SOURCES lists the three agreed sites', () => {
  assert.deepEqual(SOURCES.map((s) => s.source), ['bankbazaar', 'tatacapital', 'idfcfirst']);
});

test('normalizeProducts keeps explicit criteria and canonicalises them', () => {
  const [p] = normalizeProducts([{
    lender: ' Tata  Capital ', product_name: 'Personal Loan', rate_min: 10.99, rate_max: 29.99,
    min_monthly_income: 15000, min_credit_score: 700, min_age: 22, max_age: 58,
    employment_types: ['salaried employees', 'Self-employed professionals'],
    max_loan_amount: 3500000, max_tenure_months: 72, eligibility_notes: ' 1 year of work experience ',
  }], LENDER_PAGE);
  assert.match(p.criteria_hash, /^[0-9a-f]{16}$/);
  assert.deepEqual({ ...p, criteria_hash: 'x' }, {
    source: 'tatacapital', source_url: LENDER_PAGE.url, lender: 'Tata Capital', product_name: 'Personal Loan',
    rate_min: 10.99, rate_max: 29.99, min_monthly_income: 15000, min_credit_score: 700, min_age: 22, max_age: 58,
    employment_types: ['Salaried', 'Self-Employed'], max_loan_amount: 3500000, max_tenure_months: 72,
    eligibility_notes: '1 year of work experience', criteria_source: 'explicit', criteria_hash: 'x',
  });
});

test('normalizeProducts fills missing criteria with defaults and marks them inferred', () => {
  const [p] = normalizeProducts([{ lender: 'HDFC Bank', product_name: null, rate_min: 10.9, rate_max: null }], AGGREGATOR);
  assert.equal(p.product_name, 'HDFC Bank Personal Loan');
  assert.equal(p.rate_max, 10.9);
  assert.equal(p.min_monthly_income, DEFAULTS.min_monthly_income);
  assert.equal(p.min_credit_score, DEFAULTS.min_credit_score);
  assert.deepEqual(p.employment_types, DEFAULTS.employment_types);
  assert.equal(p.criteria_source, 'inferred');
});

test('normalizeProducts repairs and rejects bad values', () => {
  const out = normalizeProducts([
    { lender: 'A', product_name: 'Annual', rate_min: 30, rate_max: 12, min_monthly_income: 600000, min_credit_score: 720, min_age: 21, max_age: 60, employment_types: ['Salaried'] },
    { lender: 'B', product_name: 'Bad rate', rate_min: 0.5, rate_max: 0.9 },
    { lender: 'C', product_name: 'Too high', rate_min: 55, rate_max: 60 },
    { lender: '', product_name: 'No lender', rate_min: 11, rate_max: 12 },
    { lender: 'A', product_name: 'annual', rate_min: 11, rate_max: 12 },
  ], AGGREGATOR);
  assert.equal(out.length, 1, 'bad rates, missing lender and case-insensitive duplicates are dropped');
  assert.deepEqual([out[0].rate_min, out[0].rate_max], [12, 30], 'min/max swapped');
  assert.equal(out[0].min_monthly_income, 50000, 'annual income converted to monthly');
  assert.equal(normalizeProducts('not an array', AGGREGATOR).length, 0);
});

test('criteria_hash changes only when criteria change', () => {
  const base = { lender: 'X', product_name: 'P', rate_min: 11, rate_max: 20, min_monthly_income: 30000, min_credit_score: 720, min_age: 21, max_age: 60, employment_types: ['Salaried'] };
  const [a] = normalizeProducts([base], AGGREGATOR);
  const [b] = normalizeProducts([{ ...base }], { ...AGGREGATOR, url: 'https://other.example' });
  const [c] = normalizeProducts([{ ...base, min_credit_score: 750 }], AGGREGATOR);
  assert.equal(a.criteria_hash, b.criteria_hash);
  assert.notEqual(a.criteria_hash, c.criteria_hash);
});

test('buildExtractionRequest embeds the page text and the product schema', () => {
  const request = buildExtractionRequest({ ...LENDER_PAGE, text: 'Interest 10.99% p.a.' });
  const prompt = request.contents[0].parts[0].text;
  assert.ok(prompt.includes('Interest 10.99% p.a.'));
  assert.ok(prompt.includes('Use lender "Tata Capital"'));
  assert.equal(request.generationConfig.responseSchema.type, 'ARRAY');
  assert.ok(buildExtractionRequest({ ...AGGREGATOR, text: 't' }).contents[0].parts[0].text.includes('one product per lender'));
});

test('preparePage reports fetch errors and thin pages', () => {
  assert.equal(preparePage(LENDER_PAGE, { error: { message: 'timeout' } }).error, 'timeout');
  assert.match(preparePage(LENDER_PAGE, { html: '<p>hello</p>' }).error, /only \d+ characters/);
  const ok = preparePage(LENDER_PAGE, { html: `<p>${'Interest rate 10.99% p.a. for salaried applicants. '.repeat(10)}</p>` });
  assert.equal(ok.ok, true);
  assert.match(ok.hash, /^[0-9a-f]{16}$/);
});

test('planCrawl sends only changed pages to the LLM', () => {
  const pages = [
    { ...AGGREGATOR, ok: true, text: 'a', hash: 'h1' },
    { ...LENDER_PAGE, ok: true, text: 'b', hash: 'h2' },
    { source: 'idfcfirst', kind: 'lender', lender: 'IDFC FIRST Bank', url: 'https://idfc.example', ok: false, error: 'HTTP 403', hash: null },
  ];
  const plan = planCrawl(pages, [{ url: LENDER_PAGE.url, last_hash: 'h2' }]);
  assert.deepEqual(plan.map((p) => [p.source, p.outcome, p.needs_llm]), [
    ['bankbazaar', 'changed', true], ['tatacapital', 'unchanged', false], ['idfcfirst', 'failed', false],
  ]);
  assert.ok(plan[0].gemini_request);
  assert.match(plan[1].sql, /'unchanged'/);
  assert.match(plan[2].sql, /HTTP 403/);
});

test('pageResult builds an upsert for valid products', () => {
  const result = pageResult({ ...LENDER_PAGE, hash: 'h' }, geminiOk([{ lender: 'Tata Capital', product_name: 'Personal Loan', rate_min: 10.99, rate_max: 29.99 }]));
  assert.equal(result.outcome, 'ok');
  assert.equal(result.products, 1);
  assert.match(result.sql, /INSERT INTO loan_products/);
});

test('pageResult marks the source failed and never deactivates when nothing valid came back', () => {
  const cases = [
    geminiOk([]),
    geminiOk([{ lender: 'X', product_name: 'P', rate_min: 99, rate_max: 99 }]),
    { candidates: [{ content: { parts: [{ text: 'not json' }] } }] },
    { error: { message: 'HTTP 429' } },
  ];
  for (const response of cases) {
    const result = pageResult({ ...LENDER_PAGE, hash: 'h' }, response);
    assert.equal(result.outcome, 'failed');
    assert.ok(!/UPDATE loan_products/.test(result.sql), 'must not touch products');
    assert.match(result.sql, /'failed'/);
  }
});

test('cleanHtml trims pipes in linear time on rows with many empty cells', () => {
  const html = `<table><tr><td>x</td>${'<td></td>'.repeat(60)}<td>rate 10%</td></tr></table>`;
  const start = Date.now();
  const text = cleanHtml(html);
  assert.ok(Date.now() - start < 500, 'must not backtrack catastrophically');
  assert.ok(text.includes('x |') && text.includes('rate 10%'));
});
