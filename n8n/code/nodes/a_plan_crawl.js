// Workflow A › "Plan crawl": unchanged and failed pages skip the LLM entirely.
const { planCrawl } = require('../lib/crawl');

const { pages } = $('Clean & hash pages').first().json;

return planCrawl(pages, $input.first().json.state).map((json) => ({ json }));
