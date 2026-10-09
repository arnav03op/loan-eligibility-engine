// Workflow B › "Stage 3a: plan LLM work": reuse cached verdicts, batch the rest
// (40 questions per call, capped by LLM_MAX_CALLS).
const { planLlmWork } = require('../lib/matching');

const plan = planLlmWork({
  stage2: $('Stage 2: rules & scoring').first().json,
  products: $('Fetch active products').first().json.products ?? [],
  hits: $input.first().json.hits ?? [],
  maxCalls: Number($('Config').first().json.llm_max_calls),
});

return [{ json: plan }];
