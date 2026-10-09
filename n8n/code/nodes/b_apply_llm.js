// Workflow B › "Stage 3b: apply LLM verdicts": merge Gemini's answers (and the
// cache) with the rule decisions into one persist statement.
const { applyLlmDecisions } = require('../lib/matching');

const result = applyLlmDecisions({
  stage2: $('Stage 2: rules & scoring').first().json,
  plan: $('Stage 3a: plan LLM work').first().json,
  responses: $input.all().map((item) => item.json),
});

return [{ json: result }];
