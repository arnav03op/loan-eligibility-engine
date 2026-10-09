// Workflow A › "Clean & hash pages": reduce each fetched page to its loan-relevant
// text and fingerprint it. Emits ONE item: all pages + the crawl-state query.
const { preparePage } = require('../lib/crawl');
const { buildCrawlStateSql } = require('../lib/crawl_sql');

const pages = $input.all().map((item, index) => preparePage($('Sources').itemMatching(index).json, item.json));

return [{ json: { pages, sql: buildCrawlStateSql(pages.map((page) => page.url)) } }];
