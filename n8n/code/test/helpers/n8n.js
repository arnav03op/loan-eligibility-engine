// Test-only helpers for running bundled Code-node source outside n8n.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../../..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadWorkflow(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'n8n/workflows', file), 'utf8'));
}

function codeOf(workflow, nodeName) {
  const node = workflow.nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`node not found: ${nodeName}`);
  return node.parameters.jsCode;
}

// Runs Code-node source with stand-ins for n8n's globals.
function runCode(jsCode, { $input, $, $json } = {}) {
  const fn = new AsyncFunction('$input', '$', '$json', 'require', jsCode);
  return fn.call({}, $input, $, $json, require);
}

// Minimal $input / $('Node') stand-ins (itemMatching follows index pairing).
function items(...jsons) {
  const list = jsons.map((json) => ({ json }));
  return { all: () => list, first: () => list[0], item: list[0], itemMatching: (i) => list[i] };
}

module.exports = { ROOT, loadWorkflow, codeOf, runCode, items };
