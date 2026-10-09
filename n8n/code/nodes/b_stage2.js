// Workflow B › "Stage 2: rules & scoring": settle most pairs with cheap rules and
// collapse the rest into (profile bucket × product) questions for the LLM.
const { runStage2 } = require('../lib/matching');
const { buildCacheLookupSql } = require('../lib/matching_sql');

const query = $('Build query SQL').first().json;
const products = $('Fetch active products').first().json.products ?? [];
const stage2 = runStage2({ ...$input.first().json, batch_id: query.batch_id, started_at: query.started_at }, products);

return [{ json: { ...stage2, cache_sql: buildCacheLookupSql(stage2.bucket_pairs) } }];
