'use strict';

const { z } = require('zod');

const GEMINI_AUTH_MODE = 'x-goog-api-key header via callGeminiGenerateContent (not ?key=)';

const EXTRACT_SYSTEM_PROMPT = `You understand web pages from a structured outline (visible text, landmarks, and numbered candidate blocks with optional adjacent metadata such as view counts, dates, and prices).

The user gives a free-text request. Return sticky-note items that satisfy THAT request (e.g. ranking "highest viewed", listing deadlines, highlighting prices). Use adjacent metadata on anchors when ranking or comparing.

OUTPUT FORMAT (mandatory):
Return exactly one JSON object, no markdown fences, no text before or after. Shape:
{"items":[{"type":"short category","title":"brief title","snippet":"one-line quote or paraphrase","importance":3,"anchorIndex":0}]}

Rules:
- "items" is an array matching the user request. Use 0–12 items. Empty array is allowed if nothing matches.
- Rank when the user asks for popular / highest / soonest / cheapest / etc., using metadata on the numbered anchors.
- "type" is a short label such as heading, deadline, message, task, event, fact, warning, video.
- "importance" is an integer 1–5 (5 = most important / best match).
- "anchorIndex" MUST be an integer from the numbered CANDIDATE ANCHORS list. Never invent CSS selectors, XPaths, or element ids.
- Do not mention passwords, payment details, or hidden form values.
- Never put prose outside the JSON.`;

const NotableItemSchema = z.object({
  type: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  snippet: z.string().trim().max(500).default(''),
  importance: z.coerce.number().int().min(1).max(5),
  anchorIndex: z.coerce.number().int().nonnegative(),
});

const ExtractResponseSchema = z.object({
  items: z.array(NotableItemSchema).max(12),
});

function stripFences(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  return text;
}

function serializeBody(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function parseExtractJson(raw) {
  const text = stripFences(raw);
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const wrapped = new Error(`Model did not return valid JSON: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }
  const parsed = ExtractResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Model JSON failed schema validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

function filterItemsToAnchors(data, anchorCount) {
  const max = Math.max(0, Number(anchorCount) || 0);
  const items = data.items.filter((item) => item.anchorIndex < max);
  return { items };
}

function formatOutlineForModel(outline) {
  const anchors = Array.isArray(outline.anchors) ? outline.anchors : [];
  const landmarks = Array.isArray(outline.landmarks) ? outline.landmarks : [];
  const lines = [];
  lines.push(`PAGE TITLE: ${outline.title || ''}`);
  lines.push('');
  lines.push('INNER TEXT (truncated, sensitive fields stripped):');
  lines.push(String(outline.innerText || '').slice(0, 8000));
  lines.push('');
  lines.push('LANDMARKS:');
  for (const lm of landmarks.slice(0, 80)) {
    lines.push(`- ${lm.tag || ''} ${lm.role ? `role=${lm.role}` : ''} ${lm.datetime ? `datetime=${lm.datetime}` : ''} ${lm.preview || ''}`.trim());
  }
  lines.push('');
  lines.push('CANDIDATE ANCHORS (use only these indices). Each line is title preview plus adjacent metadata:');
  for (const a of anchors) {
    const meta = a.meta ? ` | meta: ${a.meta}` : '';
    lines.push(`[${a.index}] ${a.preview || ''}${meta}`);
  }
  if (outline.truncated) lines.push('\n(Outline was truncated for size.)');
  return lines.join('\n').slice(0, 16000);
}

function buildExtractUserText(outline, userPrompt) {
  const request = String(userPrompt || '').trim() || '(no specific request — pick the most notable items)';
  return `USER REQUEST:\n${request}\n\n${formatOutlineForModel(outline)}\n\nRespond with only the JSON object described in your instructions.`;
}

async function extractNotableItems({ outline, userPrompt, callGemini }) {
  const anchors = Array.isArray(outline && outline.anchors) ? outline.anchors : [];
  const userText = buildExtractUserText(outline, userPrompt);
  let lastDebug = {
    geminiAuth: GEMINI_AUTH_MODE,
    rawGeminiBody: '',
    modelText: '',
  };

  const run = async (extraUser) => {
    const result = await callGemini({
      systemText: EXTRACT_SYSTEM_PROMPT,
      userText: extraUser || userText,
      generationConfig: {
        temperature: 0.2,
        topP: 0.8,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    lastDebug = {
      geminiAuth: result.geminiAuth || GEMINI_AUTH_MODE,
      requestUrl: result.requestUrl || '',
      rawGeminiBody: serializeBody(result.rawBody),
      modelText: String(result.text || ''),
      usedModel: result.usedModel,
      finishReason: result.finishReason
        || (result.rawBody && result.rawBody.candidates && result.rawBody.candidates[0] && result.rawBody.candidates[0].finishReason)
        || null,
    };
    console.log('[patches:notes] geminiExtract auth:', lastDebug.geminiAuth);
    console.log('[patches:notes] geminiExtract url:', lastDebug.requestUrl);
    console.log('[patches:notes] geminiExtract finishReason:', lastDebug.finishReason);
    console.log('[patches:notes] geminiExtract raw body:', lastDebug.rawGeminiBody);
    const parsed = parseExtractJson(result.text);
    return {
      ...filterItemsToAnchors(parsed, anchors.length),
      usedModel: result.usedModel,
      fallbackUsed: result.fallbackUsed,
      fallbackError: result.fallbackError,
      debug: lastDebug,
    };
  };

  try {
    return await run();
  } catch (err) {
    err.notesDebug = {
      ...lastDebug,
      rawGeminiBody: err.rawGeminiBody != null ? serializeBody(err.rawGeminiBody) : lastDebug.rawGeminiBody,
      geminiAuth: err.geminiAuth || lastDebug.geminiAuth,
      requestUrl: err.requestUrl || lastDebug.requestUrl,
      finishReason: err.finishReason || lastDebug.finishReason || null,
      error: err.message,
      stack: err.stack,
    };
    console.error('[patches:notes] geminiExtract failed:', err.message);
    console.error('[patches:notes] finishReason:', err.notesDebug.finishReason);
    console.error('[patches:notes] stack:', err.stack);
    console.error('[patches:notes] auth:', err.notesDebug.geminiAuth);
    console.error('[patches:notes] raw Gemini body:', err.notesDebug.rawGeminiBody);
    if (err.geminiQuota) throw err;
    try {
      return await run(`${userText}\n\nYour previous output was invalid. Return only valid JSON matching the schema.`);
    } catch (retryErr) {
      retryErr.notesDebug = {
        ...err.notesDebug,
        rawGeminiBody: retryErr.rawGeminiBody != null ? serializeBody(retryErr.rawGeminiBody) : err.notesDebug.rawGeminiBody,
        finishReason: retryErr.finishReason || err.notesDebug.finishReason || null,
        error: retryErr.message,
        stack: retryErr.stack,
        retried: true,
      };
      throw retryErr;
    }
  }
}

module.exports = {
  EXTRACT_SYSTEM_PROMPT,
  GEMINI_AUTH_MODE,
  NotableItemSchema,
  ExtractResponseSchema,
  parseExtractJson,
  filterItemsToAnchors,
  formatOutlineForModel,
  buildExtractUserText,
  extractNotableItems,
};
