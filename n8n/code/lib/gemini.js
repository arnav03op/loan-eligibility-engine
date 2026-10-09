'use strict';
// Gemini REST helpers. Requests use responseSchema (native structured output), so
// the model returns JSON that matches the schema instead of free text.

// Builds the Gemini request with a fixed answer format.
function geminiRequest(prompt, responseSchema) {
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema },
  };
}

// Reads the JSON answer out of Gemini's reply.
function parseGeminiJson(response) {
  const parts = response?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((part) => part.text ?? '').join('');
  if (!text) {
    throw new Error(`Gemini returned no content: ${JSON.stringify(response ?? null).slice(0, 300)}`);
  }
  return JSON.parse(text);
}

module.exports = { geminiRequest, parseGeminiJson };
