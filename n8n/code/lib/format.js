'use strict';
// Display and comparison helpers shared by emails, alerts, prompts and webhook checks.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Makes text safe to put inside HTML.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Indian digit grouping (1,50,000). Done by hand so output never depends on
// the ICU data shipped with a particular Node build.
function formatInr(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return '₹—';
  const digits = String(Math.abs(n));
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${n < 0 ? '-' : ''}₹${grouped}`;
}

// Allows only normal http/https links.
function safeHttpUrl(value) {
  const text = String(value ?? '');
  return /^https?:\/\/[^\s"'<>]+$/i.test(text) ? text : null;
}

// Constant-time comparison for signatures (no early exit on the first mismatch).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

module.exports = { escapeHtml, formatInr, safeHttpUrl, safeEqual };
