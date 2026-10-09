'use strict';
// Crawl targets, the Gemini extraction request, and normalisation of what the
// model returns into rows that satisfy loan_products' constraints.

const { geminiRequest } = require('./gemini');
const { contentHash, stableStringify } = require('./hash');

const SOURCES = [
  { source: 'bankbazaar', kind: 'aggregator', lender: null, url: 'https://www.bankbazaar.com/personal-loan.html' },
  { source: 'tatacapital', kind: 'lender', lender: 'Tata Capital', url: 'https://www.tatacapital.com/personal-loan.html' },
  { source: 'idfcfirst', kind: 'lender', lender: 'IDFC FIRST Bank', url: 'https://www.idfcfirstbank.com/personal-banking/loans/personal-loan' },
];

const EMPLOYMENT_TYPES = ['Salaried', 'Self-Employed', 'Business'];

// Used when a page does not state a criterion; the product is then 'inferred'.
const DEFAULTS = {
  min_monthly_income: 25000,
  min_credit_score: 700,
  min_age: 21,
  max_age: 60,
  employment_types: EMPLOYMENT_TYPES,
};

const PRODUCT_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      lender: { type: 'STRING' },
      product_name: { type: 'STRING', nullable: true },
      rate_min: { type: 'NUMBER', nullable: true },
      rate_max: { type: 'NUMBER', nullable: true },
      min_monthly_income: { type: 'NUMBER', nullable: true },
      min_credit_score: { type: 'INTEGER', nullable: true },
      min_age: { type: 'INTEGER', nullable: true },
      max_age: { type: 'INTEGER', nullable: true },
      employment_types: { type: 'ARRAY', items: { type: 'STRING' }, nullable: true },
      max_loan_amount: { type: 'NUMBER', nullable: true },
      max_tenure_months: { type: 'INTEGER', nullable: true },
      eligibility_notes: { type: 'STRING', nullable: true },
    },
    required: ['lender', 'rate_min', 'rate_max'],
  },
};

// Writes the instructions we give Gemini.
function buildExtractionPrompt(page) {
  const scope = page.kind === 'aggregator'
    ? 'This is an aggregator page comparing many lenders. Return one product per lender listed, with product_name "<Lender> Personal Loan" unless the page names the product.'
    : `This is the lender's own page. Use lender "${page.lender}" and return each distinct personal loan variant described (often just one).`;
  return [
    'Extract personal loan products from this Indian financial website.',
    `URL: ${page.url}`,
    scope,
    '',
    'Rules:',
    '- Only personal loans; skip home, car, gold, education and business loans.',
    '- rate_min / rate_max: annual interest rate in percent. If only "from X%" is shown, set rate_min = X and rate_max = null.',
    '- min_monthly_income: minimum NET MONTHLY income in rupees. Convert annual figures (divide by 12) and lakh amounts (1 lakh = 100000).',
    '- min_credit_score: minimum CIBIL score if stated.',
    '- min_age / max_age: applicant age limits in years.',
    '- employment_types: which of "Salaried", "Self-Employed", "Business" the product accepts.',
    '- max_loan_amount in rupees; max_tenure_months in months.',
    '- eligibility_notes: one short sentence on other conditions (work experience, business vintage, cities), else null.',
    '- Use null for anything the page does not state. Never guess.',
    '',
    'Page text:',
    '"""',
    page.text,
    '"""',
  ].join('\n');
}

// Builds the full Gemini request for a page.
function buildExtractionRequest(page) {
  return geminiRequest(buildExtractionPrompt(page), PRODUCT_SCHEMA);
}

// Reads a number, or null if it's not valid.
function num(value) {
  const n = typeof value === 'string' ? Number(value.replace(/[,₹\s]/g, '')) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

// Checks a number is within limits.
const inRange = (n, lo, hi) => n !== null && n >= lo && n <= hi;
// Tidies up a product name.
const cleanName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

// Cleans the list of job types.
function normalizeEmployment(list) {
  if (!Array.isArray(list)) return null;
  const found = new Set();
  for (const item of list) {
    const text = String(item).toLowerCase();
    if (text.includes('self')) found.add('Self-Employed');
    else if (text.includes('salar')) found.add('Salaried');
    else if (text.includes('business') || text.includes('proprietor')) found.add('Business');
  }
  return found.size ? EMPLOYMENT_TYPES.filter((t) => found.has(t)) : null;
}

const CRITERIA_FIELDS = ['rate_min', 'rate_max', 'min_monthly_income', 'min_credit_score', 'min_age', 'max_age',
  'employment_types', 'max_loan_amount', 'max_tenure_months', 'eligibility_notes'];

// Checks one AI product and fills safe defaults.
function normalizeProduct(raw, page) {
  const lender = cleanName(raw?.lender || page.lender);
  if (!lender) return null;
  const productName = cleanName(raw?.product_name) || `${lender} Personal Loan`;

  let rateMin = num(raw?.rate_min);
  let rateMax = num(raw?.rate_max);
  if (rateMin === null) rateMin = rateMax;
  if (rateMax === null) rateMax = rateMin;
  if (!inRange(rateMin, 5, 40) || !inRange(rateMax, 5, 40)) return null;
  if (rateMin > rateMax) [rateMin, rateMax] = [rateMax, rateMin];

  let inferred = false;
  const pick = (value, isValid, fallback) => {
    if (isValid(value)) return value;
    inferred = true;
    return fallback;
  };

  let income = num(raw?.min_monthly_income);
  if (income !== null && income > 200000) income = Math.round(income / 12); // an annual figure slipped through
  const minIncome = pick(income, (v) => inRange(v, 5000, 200000), DEFAULTS.min_monthly_income);
  const minCredit = pick(num(raw?.min_credit_score), (v) => Number.isInteger(v) && inRange(v, 300, 900), DEFAULTS.min_credit_score);
  const minAge = pick(num(raw?.min_age), (v) => Number.isInteger(v) && inRange(v, 18, 70), DEFAULTS.min_age);
  const maxAge = pick(num(raw?.max_age), (v) => Number.isInteger(v) && inRange(v, minAge + 1, 80), DEFAULTS.max_age);
  if (maxAge <= minAge) return null;
  const employment = pick(normalizeEmployment(raw?.employment_types), (v) => v !== null, DEFAULTS.employment_types);

  const maxLoan = num(raw?.max_loan_amount);
  const tenure = num(raw?.max_tenure_months);
  const notes = typeof raw?.eligibility_notes === 'string' ? raw.eligibility_notes.trim().slice(0, 500) : '';

  const product = {
    source: page.source,
    source_url: page.url,
    lender,
    product_name: productName,
    rate_min: rateMin,
    rate_max: rateMax,
    min_monthly_income: minIncome,
    min_credit_score: minCredit,
    min_age: minAge,
    max_age: maxAge,
    employment_types: employment,
    max_loan_amount: maxLoan !== null && maxLoan > 0 ? maxLoan : null,
    max_tenure_months: Number.isInteger(tenure) && inRange(tenure, 6, 120) ? tenure : null,
    eligibility_notes: notes || null,
    criteria_source: inferred ? 'inferred' : 'explicit',
  };
  product.criteria_hash = contentHash(stableStringify(Object.fromEntries(CRITERIA_FIELDS.map((f) => [f, product[f]]))));
  return product;
}

// Validate, repair and de-duplicate (case-insensitive lender + product name).
function normalizeProducts(raw, page) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const product = normalizeProduct(item, page);
    if (!product) continue;
    const key = `${product.lender.toLowerCase()}|${product.product_name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(product);
  }
  return out;
}

module.exports = { SOURCES, DEFAULTS, EMPLOYMENT_TYPES, PRODUCT_SCHEMA, buildExtractionRequest, normalizeProducts };
