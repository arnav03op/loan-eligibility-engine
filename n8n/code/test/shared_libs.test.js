const test = require('node:test');
const assert = require('node:assert/strict');
const { quoteLiteral, jsonLiteral, uuidLiteral, intLiteral, timestampLiteral } = require('../lib/sql_literal');
const { contentHash, stableStringify } = require('../lib/hash');
const { escapeHtml, formatInr, safeHttpUrl, safeEqual } = require('../lib/format');
const { geminiRequest, parseGeminiJson } = require('../lib/gemini');

test('quoteLiteral doubles single quotes and keeps backslashes literal', () => {
  assert.equal(quoteLiteral("O'Brien"), "'O''Brien'");
  assert.equal(quoteLiteral('a\\b'), "'a\\b'");
});

test('quoteLiteral rejects NUL characters', () => {
  assert.throws(() => quoteLiteral('a\u0000b'), /NUL/);
});

test('jsonLiteral hides $ and ; from the n8n parameter formatter', () => {
  const literal = jsonLiteral({ r: 'costs $1; ok' });
  assert.equal(literal, `'{"r":"costs \\u00241\\u003b ok"}'::json`);
  assert.ok(!literal.includes('$') && !literal.includes(';'));
});

test('uuidLiteral validates and lower-cases', () => {
  assert.equal(uuidLiteral('123E4567-E89B-42D3-A456-426614174000'), "'123e4567-e89b-42d3-a456-426614174000'::uuid");
  assert.throws(() => uuidLiteral("x'; DROP TABLE users; --"), /invalid uuid/);
  assert.throws(() => uuidLiteral(null), /invalid uuid/);
});

test('intLiteral and timestampLiteral validate', () => {
  assert.equal(intLiteral(42), '42');
  assert.throws(() => intLiteral(1.5));
  assert.throws(() => intLiteral('42'));
  assert.equal(timestampLiteral('2026-10-07T10:00:00Z'), "'2026-10-07T10:00:00.000Z'::timestamptz");
  assert.throws(() => timestampLiteral('not a date'));
});

test('contentHash is stable, short and sensitive to changes', () => {
  assert.equal(contentHash('abc'), contentHash('abc'));
  assert.match(contentHash('abc'), /^[0-9a-f]{16}$/);
  assert.notEqual(contentHash('abc'), contentHash('abd'));
  assert.equal(contentHash(''), 'cbf29ce484222325'); // FNV-1a 64-bit offset basis
});

test('stableStringify sorts keys at every level', () => {
  assert.equal(stableStringify({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } }), '{"a":{"c":null,"d":[2,{"x":0,"y":1}]},"b":1}');
});

test('formatInr uses Indian digit grouping', () => {
  assert.equal(formatInr(150000), '₹1,50,000');
  assert.equal(formatInr(85000), '₹85,000');
  assert.equal(formatInr(12345678), '₹1,23,45,678');
  assert.equal(formatInr(999), '₹999');
  assert.equal(formatInr('25000.40'), '₹25,000');
});

test('escapeHtml, safeHttpUrl and safeEqual', () => {
  assert.equal(escapeHtml(`<b>"O'Brien" & co</b>`), '&lt;b&gt;&quot;O&#39;Brien&quot; &amp; co&lt;/b&gt;');
  assert.equal(safeHttpUrl('https://bank.example/pl'), 'https://bank.example/pl');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeEqual('abcd', 'abcd'), true);
  assert.equal(safeEqual('abcd', 'abce'), false);
  assert.equal(safeEqual('abcd', 'abc'), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
});

test('geminiRequest asks for schema-constrained JSON', () => {
  const schema = { type: 'ARRAY', items: { type: 'STRING' } };
  assert.deepEqual(geminiRequest('hi', schema), {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema },
  });
});

test('parseGeminiJson extracts and parses the candidate text', () => {
  const response = { candidates: [{ content: { parts: [{ text: '[{"a":' }, { text: '1}]' }] } }] };
  assert.deepEqual(parseGeminiJson(response), [{ a: 1 }]);
  assert.throws(() => parseGeminiJson({ promptFeedback: { blockReason: 'SAFETY' } }), /no content/);
  assert.throws(() => parseGeminiJson({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }), SyntaxError);
});
