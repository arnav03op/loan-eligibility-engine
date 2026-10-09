'use strict';
// Workflow E: turn n8n's Error Trigger payload into a short, safe alert email.

const { escapeHtml, safeHttpUrl } = require('./format');

// Builds the error alert email text.
function buildAlert(data) {
  const workflow = data?.workflow?.name ?? 'Unknown workflow';
  const execution = data?.execution ?? {};
  const node = execution.lastNodeExecuted ?? execution.error?.node?.name ?? 'unknown node';
  const message = execution.error?.message ?? 'Unknown error';
  const url = safeHttpUrl(execution.url);
  return {
    subject: `[Loan Engine] ${workflow} failed at ${node}`,
    html: [
      `<p><b>Workflow:</b> ${escapeHtml(workflow)}</p>`,
      `<p><b>Failed node:</b> ${escapeHtml(node)}</p>`,
      `<p><b>Error:</b> ${escapeHtml(message)}</p>`,
      url ? `<p><a href="${escapeHtml(url)}">Open the execution in n8n</a></p>` : '',
    ].join('\n'),
  };
}

module.exports = { buildAlert };
