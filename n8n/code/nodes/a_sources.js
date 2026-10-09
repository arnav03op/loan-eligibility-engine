// Workflow A › "Sources": one item per site to crawl.
const { SOURCES } = require('../lib/products');

return SOURCES.map((source) => ({ json: source }));
