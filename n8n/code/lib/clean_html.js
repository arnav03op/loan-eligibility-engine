'use strict';
// Reduce a lender web page to the lines that matter for loan eligibility, so the
// LLM reads ~2% of the original bytes: cheaper, faster and less distracted.

const DROP_BLOCKS = /<(script|style|noscript|svg|iframe|template|head|nav|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
const CELL_END = /<\/(td|th)\s*>/gi;
const LINE_BREAKS = /<(br|hr)\b[^>]*>|<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|dd|dt)\s*>/gi;
const TAGS = /<[^>]+>/g;
const KEYWORDS = /interest|\brates?\b|p\.\s?a\.|eligib|cibil|credit score|\bincome|salar|self[- ]employed|business|\bage\b|tenure|loan amount|lakh|processing fee|₹|\brs\.?\s?\d|\d\s?%/i;
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'",
  ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', hellip: '...', rupee: '₹',
};

// Turns things like &amp; back into normal text.
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

// Strips the HTML down to plain text lines.
function htmlToLines(html) {
  const text = String(html ?? '')
    .replace(COMMENTS, ' ')
    .replace(DROP_BLOCKS, ' ')
    .replace(CELL_END, ' | ')
    .replace(LINE_BREAKS, '\n')
    .replace(TAGS, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').replace(/^[\s|]+|[\s|]+$/g, '').trim())
    .filter((line) => line.length > 1);
}

// Keep keyword lines plus `context` neighbouring lines, de-duplicated, up to maxChars.
function cleanHtml(html, { maxChars = 15000, context = 1 } = {}) {
  const lines = htmlToLines(html);
  const keep = new Set();
  lines.forEach((line, i) => {
    if (!KEYWORDS.test(line)) return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j += 1) keep.add(j);
  });
  const out = [];
  const seen = new Set();
  let size = 0;
  for (const i of [...keep].sort((a, b) => a - b)) {
    const line = lines[i];
    if (seen.has(line)) continue;
    if (size + line.length + 1 > maxChars) break;
    seen.add(line);
    out.push(line);
    size += line.length + 1;
  }
  return out.join('\n');
}

module.exports = { cleanHtml, htmlToLines, decodeEntities };
