// Workflow B › "One item per LLM batch".
return $input.first().json.llm_batches.map((batch) => ({ json: batch }));
