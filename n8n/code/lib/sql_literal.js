'use strict';
// SQL literal builders. Every query the workflows run is assembled from these,
// so escaping lives in one tested place.
//
// Safety model: PostgreSQL (standard_conforming_strings = on, the default since
// 9.1) treats backslashes in '...' as ordinary characters, so doubling single
// quotes is a complete escape. Inside JSON payloads '$' and ';' are also written
// as \u0024 / \u003b, so the n8n Postgres node's parameter formatter never sees
// a "$1"-style token or a statement separator in our data.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Safely quotes a text value for SQL.
function quoteLiteral(value) {
  const text = String(value);
  if (text.includes('\u0000')) throw new Error('NUL character not allowed in SQL literal');
  return `'${text.replace(/'/g, "''")}'`;
}

// Safely writes JSON as an SQL value.
function jsonLiteral(value) {
  const json = JSON.stringify(value).replace(/\$/g, '\\u0024').replace(/;/g, '\\u003b');
  return `${quoteLiteral(json)}::json`;
}

// Free text that may contain '$' or ';' (emails, error messages): carried as a
// JSON string so those characters are hidden too, then unwrapped to text.
function textLiteral(value) {
  const text = String(value);
  if (text.includes('\u0000')) throw new Error('NUL character not allowed in SQL literal');
  return `(${jsonLiteral(text)}#>>'{}')`;
}

// Checks it's a real UUID before using it in SQL.
function uuidLiteral(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new Error(`invalid uuid: ${value}`);
  return `${quoteLiteral(value.toLowerCase())}::uuid`;
}

// Checks it's a whole number before using it in SQL.
function intLiteral(value) {
  if (!Number.isSafeInteger(value)) throw new Error(`invalid integer: ${value}`);
  return String(value);
}

// Checks it's a valid time before using it in SQL.
function timestampLiteral(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid timestamp: ${value}`);
  return `${quoteLiteral(date.toISOString())}::timestamptz`;
}

module.exports = { UUID_RE, quoteLiteral, jsonLiteral, textLiteral, uuidLiteral, intLiteral, timestampLiteral };
