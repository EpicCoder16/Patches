'use strict';

const GEMINI_RETRIES_PER_MODEL = 3;
const GEMINI_RETRY_BACKOFF_MS = [700, 1800, 3500];

function geminiGenerateUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isGeminiCapacityError(status, msg) {
  return (
    status === 429 ||
    status === 503 ||
    /exceeded your current quota|quota exceeded|high demand|currently overloaded|resource_exhausted|rate.?limit|free_tier|too many requests|try again later|temporarily unavailable/i.test(
      String(msg || '')
    )
  );
}

function isGeminiModelUnavailableError(status, msg) {
  const m = String(msg || '');
  return (
    status === 404 ||
    // Covers 404s ("... is not found for API version v1beta") and 400 variants Gemini returns
    // for shut-down / deprecated model IDs ("... is not supported for generateContent", "unsupported").
    /not found|is not supported|not supported for generatecontent|invalid model|unsupported|no longer available|deprecated|retired|shut down|terminated/i.test(m)
  );
}

/**
 * Shared Gemini REST call. Auth via x-goog-api-key (required for AQ. authorization keys).
 */
async function callGeminiGenerateContent({
  apiKey,
  preferredModel,
  supportedModels,
  systemText,
  userText,
  generationConfig,
}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    throw new Error('GEMINI_API_KEY not set. Add it to your .env file and restart.');
  }

  const body = {
    system_instruction: { parts: [{ text: systemText }] },
    contents: [{
      role: 'user',
      parts: [{ text: userText }],
    }],
    generationConfig: generationConfig || {
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 8192,
    },
  };

  const candidates = [preferredModel, ...supportedModels.filter((m) => m !== preferredModel)];
  let noticeFromEarlierModel = '';
  let lastModelGoneMsg = '';
  let lastWasCapacity = false;

  for (let mi = 0; mi < candidates.length; mi++) {
    const model = candidates[mi];
    const moreModels = mi < candidates.length - 1;
    let exhaustedModelMsg = '';

    for (let attempt = 0; attempt < GEMINI_RETRIES_PER_MODEL; attempt++) {
      const res = await fetch(geminiGenerateUrl(model), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': key,
        },
        body: JSON.stringify(body),
      }).catch((e) => {
        throw new Error(`Network error: ${e.message}`);
      });

      const requestUrl = geminiGenerateUrl(model);
      const geminiAuth = 'x-goog-api-key header (no ?key= query param)';
      const data = await res.json().catch(() => null);

      const finishReason = data?.candidates?.[0]?.finishReason || null;

      function attachDebug(err) {
        err.rawGeminiBody = data;
        err.requestUrl = requestUrl;
        err.geminiAuth = geminiAuth;
        err.finishReason = finishReason;
        return err;
      }

      if (!res.ok) {
        const msg = data?.error?.message || res.statusText;
        const capacityError = isGeminiCapacityError(res.status, msg);
        const modelGone = isGeminiModelUnavailableError(res.status, msg);
        const detail = `Gemini ${res.status}: ${msg}`;

        if (modelGone) {
          exhaustedModelMsg = detail;
          lastModelGoneMsg = detail;
          lastWasCapacity = false;
          break;
        }

        if (capacityError) {
          exhaustedModelMsg = detail;
          lastModelGoneMsg = detail;
          lastWasCapacity = true;
          if (attempt < GEMINI_RETRIES_PER_MODEL - 1) {
            await sleepMs(GEMINI_RETRY_BACKOFF_MS[attempt] ?? 2500);
            continue;
          }
          break;
        }

        throw attachDebug(new Error(detail));
      }

      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) {
        const reason = data?.candidates?.[0]?.finishReason || 'unknown';
        throw attachDebug(new Error(`Empty response from Gemini (finishReason: ${reason}).`));
      }

      return {
        text: raw,
        rawBody: data,
        requestUrl,
        geminiAuth,
        finishReason,
        usedModel: model,
        fallbackUsed: model !== preferredModel,
        fallbackError: model !== preferredModel ? noticeFromEarlierModel || null : null,
      };
    }

    noticeFromEarlierModel = exhaustedModelMsg || noticeFromEarlierModel;
    if (moreModels) await sleepMs(400);
  }

  // Distinguish "quota/capacity" from "the model IDs themselves are dead" so the UI
  // doesn't tell users to wait out a rate limit when the fix is updating the model list.
  if (lastWasCapacity) {
    const err = new Error(noticeFromEarlierModel || 'Gemini is temporarily out of capacity for all configured models.');
    err.geminiQuota = true;
    err.geminiErrorDetail = noticeFromEarlierModel || 'All configured Gemini models are currently in high demand.';
    throw err;
  }

  const err = new Error(
    lastModelGoneMsg ||
      'All configured Gemini models were rejected (not found or unsupported). ' +
      'Update PATCHES_MODEL / SUPPORTED_MODELS to a current model — see https://ai.google.dev/gemini-api/docs/models'
  );
  err.geminiModelUnavailable = true;
  err.geminiErrorDetail = lastModelGoneMsg || 'All configured Gemini models were rejected.';
  throw err;
}

module.exports = {
  callGeminiGenerateContent,
  geminiGenerateUrl,
  isGeminiCapacityError,
  isGeminiModelUnavailableError,
  sleepMs,
};
