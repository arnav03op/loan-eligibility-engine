'use strict';
// Personalised match emails. The recipient is ALWAYS one of the configured test
// inboxes; the CSV address only appears in the footer, as information.

const { escapeHtml, formatInr, safeHttpUrl } = require('./format');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CELL = 'padding:8px;border-bottom:1px solid #e5e8ed;text-align:left;vertical-align:top';

// Splits the test inbox list into addresses.
function parseAliases(csv) {
  const aliases = String(csv ?? '').split(',').map((a) => a.trim()).filter((a) => EMAIL_RE.test(a));
  if (!aliases.length) throw new Error('TEST_INBOX_ALIASES must contain at least one email address');
  return aliases;
}

// Gets the user's first name for the greeting.
const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || 'there';

// Writes the interest rate in a friendly way.
function rateText(p) {
  const min = Number(p.rate_min);
  const max = Number(p.rate_max);
  return min === max ? `${min}% p.a.` : `${min}%–${max}% p.a.`;
}

// Builds one loan row for the email.
function productRow(p) {
  const url = safeHttpUrl(p.source_url);
  const name = url ? `<a href="${escapeHtml(url)}">${escapeHtml(p.product_name)}</a>` : escapeHtml(p.product_name);
  return `<tr><td style="${CELL}">${escapeHtml(p.lender)}</td><td style="${CELL}">${name}</td>`
    + `<td style="${CELL};white-space:nowrap">${escapeHtml(rateText(p))}</td><td style="${CELL}">${escapeHtml(p.reason)}</td></tr>`;
}

// Builds one personal email for a user.
function buildEmail(user, recipient, batchId) {
  const products = user.products ?? [];
  const total = Number(user.match_count ?? products.length);
  const more = total - products.length;
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;color:#1d2433;line-height:1.5">',
    `<p>Hi ${escapeHtml(firstName(user.name))},</p>`,
    `<p>Based on your profile (monthly income ${formatInr(user.monthly_income)}, CIBIL ${escapeHtml(user.credit_score)}, `
      + `${escapeHtml(user.employment_status)}, age ${escapeHtml(user.age)}) you may qualify for these personal loans:</p>`,
    '<table cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px">',
    `<tr style="background:#f1f4f8"><th style="${CELL}">Lender</th><th style="${CELL}">Product</th>`
      + `<th style="${CELL}">Interest rate</th><th style="${CELL}">Why you match</th></tr>`,
    ...products.map(productRow),
    '</table>',
    more > 0 ? `<p>…and ${more} more matching product${more === 1 ? '' : 's'}.</p>` : '',
    `<p style="color:#5b6475;font-size:12px;margin-top:24px">Demo notification from the Loan Eligibility Engine `
      + `(batch ${escapeHtml(batchId)}). Originally addressed to ${escapeHtml(user.email)}; redirected to a test inbox. `
      + 'Eligibility is indicative and is not a loan offer.</p>',
    '</div>',
  ].join('\n');
  return {
    user_id: user.user_id,
    batch_id: batchId,
    original_email: user.email,
    recipient,
    subject: `${firstName(user.name)}, you may qualify for ${total} personal loan${total === 1 ? '' : 's'}`,
    html,
  };
}

// Builds all the emails for the batch.
function buildEmails({ users, aliases, batchId }) {
  const inboxes = parseAliases(aliases);
  return users.map((user, i) => buildEmail(user, inboxes[i % inboxes.length], batchId));
}

module.exports = { parseAliases, buildEmail, buildEmails };
