// Workflow A › "Normalize & build upsert": validate Gemini's products for each page and
// build the upsert, or a 'failed' record that leaves the existing products active.
const { pageResult } = require('../lib/crawl');

return $input.all().map((item, index) => ({
  json: pageResult($('Plan crawl').itemMatching(index).json, item.json),
}));
