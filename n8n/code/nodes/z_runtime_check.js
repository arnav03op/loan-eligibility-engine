// Workflow Z › "Runtime check": proves this n8n container is set up the way the real
// workflows need — bundled libs load, the Crypto node computes the shared HMAC
// vector, and $env values reach the Config node.
const { contentHash } = require('../lib/hash');

const VECTOR = '40a2925fa09fbada925a75e4073463c48a6eb7b2e06eac97acbbbb327a2a117d';
const input = $input.first().json;

return [{
  json: {
    bundled_lib_hash_of_abc: contentHash('abc'),
    crypto_node_matches_vector: input.expected_hmac === VECTOR,
    gemini_model: input.gemini_model ?? null,
    webhook_secret_configured: input.secret_configured === true,
    test_inbox_count: input.test_inbox_count ?? 0,
  },
}];
