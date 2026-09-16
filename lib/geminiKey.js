'use strict';

const MIN_KEY_LENGTH = 16;

/**
 * Google AI Studio now issues authorization keys (AQ.).
 * Legacy standard keys (AIza) are still accepted here until the API rejects them.
 */
function isValidGeminiApiKey(value) {
  const key = String(value || '').trim();
  if (key.length < MIN_KEY_LENGTH) return false;
  return key.startsWith('AQ.') || key.startsWith('AIza');
}

function geminiKeyFormatError() {
  return 'Gemini API key should start with AQ. (new authorization keys) or AIza (legacy).';
}

module.exports = { isValidGeminiApiKey, geminiKeyFormatError, MIN_KEY_LENGTH };
