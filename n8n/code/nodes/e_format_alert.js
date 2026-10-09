// Workflow E › "Format alert".
const { buildAlert } = require('../lib/alert');

return [{ json: buildAlert($input.first().json) }];
