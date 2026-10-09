'use strict';
// Workflow A decisions: prepare fetched pages, decide which need the LLM, and
// turn Gemini's answer into the right SQL for each page.

const { cleanHtml } = require('./clean_html');
const { contentHash } = require('./hash');
const { parseGeminiJson } = require('./gemini');
const { buildExtractionRequest, normalizeProducts } = require('./products');
const { buildCrawlStatusSql, buildUnchangedSql, buildUpsertProductsSql } = require('./crawl_sql');

const MIN_RELEVANT_CHARS = 200;

// Turns a fetch error into a short message.
function describeError(error) {
  if (!error) return 'empty response';
  if (typeof error === 'string') return error.slice(0, 500);
  return String(error.message ?? JSON.stringify(error)).slice(0, 500);
}

// Cleans the downloaded page and makes its fingerprint.
function preparePage(source, response) {
  const html = typeof response?.html === 'string' ? response.html : '';
  if (!html) return { ...source, ok: false, error: describeError(response?.error), text: '', hash: null };
  const text = cleanHtml(html);
  if (text.length < MIN_RELEVANT_CHARS) {
    return { ...source, ok: false, error: `page yielded only ${text.length} characters of loan-related text`, text, hash: null };
  }
  return { ...source, ok: true, error: null, text, hash: contentHash(text) };
}

// Decides which pages changed and need the AI.
function planCrawl(pages, state) {
  const lastHash = new Map((state ?? []).map((s) => [s.url, s.last_hash]));
  return pages.map((page) => {
    const meta = { source: page.source, kind: page.kind, lender: page.lender, url: page.url, hash: page.hash };
    if (!page.ok) return { ...meta, needs_llm: false, outcome: 'failed', sql: buildCrawlStatusSql(page, 'failed', page.error) };
    if (lastHash.get(page.url) === page.hash) return { ...meta, needs_llm: false, outcome: 'unchanged', sql: buildUnchangedSql(page) };
    return { ...meta, needs_llm: true, outcome: 'changed', gemini_request: buildExtractionRequest(page) };
  });
}

// An empty or invalid extraction is a failure: existing products stay active.
function pageResult(page, response) {
  try {
    if (response?.error) throw new Error(`Gemini request failed: ${describeError(response.error)}`);
    const products = normalizeProducts(parseGeminiJson(response), page);
    if (products.length === 0) throw new Error('Gemini returned no valid personal loan products');
    return { source: page.source, outcome: 'ok', products: products.length, sql: buildUpsertProductsSql(page, products) };
  } catch (err) {
    return { source: page.source, outcome: 'failed', products: 0, error: err.message, sql: buildCrawlStatusSql(page, 'failed', err.message) };
  }
}

module.exports = { preparePage, planCrawl, pageResult };
