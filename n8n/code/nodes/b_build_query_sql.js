// Workflow B › "Build query SQL": the two read queries for this batch.
const { buildProductsSql, buildStage1Sql } = require('../lib/matching_sql');

const { batch_id, started_at } = $input.first().json;

return [{ json: { batch_id, started_at, products_sql: buildProductsSql(), stage1_sql: buildStage1Sql(batch_id) } }];
