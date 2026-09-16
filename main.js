const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut, shell } = require('electron');
const path = require('path');
const fs   = require('fs');
const { isFirebaseConfigured, getFirebaseWebConfig } = require('./firebase-sync');
const { isValidGeminiApiKey, geminiKeyFormatError } = require('./lib/geminiKey');
const { callGeminiGenerateContent } = require('./lib/geminiClient');
const { extractNotableItems } = require('./lib/geminiExtract');
const { createPageNotesStore } = require('./lib/pageNotesStore');

function getAppIconPath() {
  const png = path.join(__dirname, 'build', 'icon.png');
  const rounded = path.join(__dirname, 'build', 'patcheslogorounded.png');
  if (fs.existsSync(png)) return png;
  if (fs.existsSync(rounded)) return rounded;
  return undefined;
}

function parseDotEnv(raw) {
  const out = {};
  const lines = String(raw || '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    out[key] = val;
  }
  return out;
}

function getPreferredEnvPath() {
  if (!app.isPackaged) return path.join(__dirname, '.env');
  const exeDir = path.dirname(app.getPath('exe'));
  return process.platform === 'darwin'
    ? path.resolve(exeDir, '..', '.env')
    : path.join(exeDir, '.env');
}

function getEnvCandidatePaths() {
  return [getPreferredEnvPath(), path.join(__dirname, '.env'), path.join(app.getPath('userData'), '.env')];
}

function loadDotEnv() {
  for (const candidate of getEnvCandidatePaths()) {
    try {
      const parsed = parseDotEnv(fs.readFileSync(candidate, 'utf-8'));
      for (const [key, val] of Object.entries(parsed)) {
        if (!(key in process.env)) process.env[key] = val;
      }
      return candidate;
    } catch {
      // .env file is optional; continue through fallback paths.
    }
  }
  return null;
}

function getUserEnvPath() {
  return path.join(app.getPath('userData'), '.env');
}

function upsertUserEnv(values) {
  let current = {};
  const envPath = getUserEnvPath();
  try {
    current = parseDotEnv(fs.readFileSync(envPath, 'utf-8'));
  } catch {
    current = {};
  }
  const next = { ...current, ...values };
  const lines = Object.entries(next).map(([k, v]) => `${k}=${String(v)}`);
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, `${lines.join('\n')}\n`, 'utf-8');
}

// ── Config ────────────────────────────────────────────────────────────────────
const NAV_BAR_HEIGHT     = 48;
// Must match #patches-panel width in renderer/style.css
const PATCHES_PANEL_WIDTH = 300;
let GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Default: current Gemini 2.5 Flash (v1beta). Older 1.5 IDs (e.g. gemini-1.5-flash-8b) 404 on many keys.
let GEMINI_MODEL   = process.env.PATCHES_MODEL || 'gemini-2.5-flash';
const SUPPORTED_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
];

let mainWindow   = null;
let browserView  = null;
let settingsWindow = null;
let currentURL   = 'https://www.youtube.com/';
let patchesEnabled = true;
let commandOverlayOpen = false;
let patchesPanelOpen   = false;
let isAuthenticated    = false;
let authUser           = null;
let patchesStore       = {};
let patchesCloudSync   = false;
let pageNotesStore     = null;
let notesPhase         = 'idle';
let notesExtractInFlight = false;
let notesPromptHours   = {};
const MAX_NOTES_PROMPTS_PER_HOUR = 30;

// ── Storage ───────────────────────────────────────────────────────────────────
function getPatchesFilePath() {
  if (app.isPackaged) return path.join(app.getPath('userData'), 'patches.json');
  return path.join(__dirname, 'storage', 'patches.json');
}

function loadPatchesFromDisk() {
  const patchesFile = getPatchesFilePath();
  try { return JSON.parse(fs.readFileSync(patchesFile, 'utf-8')); }
  catch { return {}; }
}

function writePatchesToDisk(patches) {
  const patchesFile = getPatchesFilePath();
  fs.mkdirSync(path.dirname(patchesFile), { recursive: true });
  fs.writeFileSync(patchesFile, JSON.stringify(patches, null, 2), 'utf-8');
}

function loadPatches() {
  return patchesStore;
}

function savePatches(patches) {
  patchesStore = patches;
  writePatchesToDisk(patches);
  if (patchesCloudSync && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-patches-to-cloud', patches);
  }
}

function mergePatchesPreferCloud(cloud, local) {
  const cloudKeys = Object.keys(cloud || {});
  if (cloudKeys.length) return cloud;
  return local || {};
}
function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

// ── CSS injection ─────────────────────────────────────────────────────────────
async function injectCSS(css, id) {
  if (!browserView || !patchesEnabled) return;
  const payload = JSON.stringify({ css: String(css || '').trim(), id });
  await browserView.webContents.executeJavaScript(`
    (function(){
      const { css, id } = ${payload};
      const old = document.getElementById(id);
      if (old) old.remove();
      if (!css) return;
      const s = document.createElement('style');
      s.id = id;
      s.textContent = css;
      document.head.appendChild(s);
    })();
  `).catch((err) => console.error('[patches] inject failed:', err.message));
}

async function removeAllInjectedCSS() {
  if (!browserView) return;
  await browserView.webContents.executeJavaScript(`
    document.querySelectorAll('style[id^="patches-"]').forEach(el => el.remove());
  `).catch(() => {});
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: 480,
    height: 348,
    minWidth: 480,
    minHeight: 348,
    maxWidth: 480,
    maxHeight: 348,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    frame: false,
    backgroundColor: '#0a0a0f',
    title: 'Patches Settings',
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'settingsPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.center();
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
    settingsWindow.focus();
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  return settingsWindow;
}

function normalisePatch(patch) {
  if (patch.aspects && Array.isArray(patch.aspects) && patch.aspects.length) {
    return {
      ...patch,
      aspects: patch.aspects.map((a, i) => ({
        id:    String(a.id != null ? a.id : i),
        label: (a.label && String(a.label).trim()) || `Part ${i + 1}`,
        css:   String(a.css || ''),
        enabled: a.enabled !== false,
      })),
    };
  }
  if (patch.css) {
    return {
      ...patch,
      aspects: [{ id: '0', label: 'Styles', css: patch.css, enabled: true }],
    };
  }
  return { ...patch, aspects: [] };
}

function combinedPatchCss(patch) {
  const p = normalisePatch(patch);
  return p.aspects.filter((a) => a.enabled && String(a.css).trim()).map((a) => a.css).join('\n');
}

async function applyDomainPatches(url) {
  if (!patchesEnabled) return;
  const list = (loadPatches()[getDomain(url)] || []);
  for (let i = 0; i < list.length; i++) await injectCSS(combinedPatchCss(list[i]), `patches-${i}`);
}

// ── DOM trimmer ───────────────────────────────────────────────────────────────
function trimDOM(rawHTML, maxChars = 5000) {
  let html = rawHTML
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Strip all attribute values EXCEPT id, class, role, aria-label — those are the selector signals
    .replace(/<([a-z][a-z0-9]*)([\s\S]*?)>/gi, (match, tag, attrs) => {
      const keep = (attrs.match(/\s(id|class|role|aria-label)="[^"]*"/gi) || []).join('');
      return `<${tag}${keep}>`;
    })
    // Collapse long text nodes to a short placeholder
    .replace(/>([^<]{80,})</g, '>[…]<')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const bodyMatch = html.match(/<body[\s\S]*<\/body>/i);
  return (bodyMatch ? bodyMatch[0] : html).slice(0, maxChars);
}

// ── CSS sanitiser ─────────────────────────────────────────────────────────────
function sanitiseCSS(raw) {
  let css = raw.replace(/^```(?:css)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const firstBrace = css.indexOf('{');
  if (firstBrace > 0) {
    const before = css.slice(0, firstBrace);
    if (/^[A-Z][^{}\n]*$/.test(before.trim())) {
      css = css.slice(firstBrace - before.trim().lastIndexOf(' ') - 1).trim();
    }
  }
  if (!css.includes('{') || !css.includes('}'))
    throw new Error('Model did not return valid CSS. Try rephrasing your prompt.');
  return css;
}

/** Strip markdown fences and parse {"aspects":[{label,css},...]} from model output. */
function parseModelAspects(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try {
    const data = JSON.parse(text);
    if (data.aspects && Array.isArray(data.aspects) && data.aspects.length) {
      const out = [];
      for (let i = 0; i < data.aspects.length; i++) {
        const a = data.aspects[i];
        const piece = String(a.css || '').trim();
        if (!piece) continue;
        try {
          out.push({
            label: String(a.label || `Part ${out.length + 1}`).trim().slice(0, 120) || `Part ${out.length + 1}`,
            css: sanitiseCSS(piece),
          });
        } catch {
          /* skip invalid aspect */
        }
      }
      if (out.length) return out;
    }
  } catch { /* not JSON */ }
  return [{ label: 'Styles', css: sanitiseCSS(raw) }];
}

// ── LLM — Google Gemini ─────────────────────────────────────────────────────
// Free tier (AI Studio key): rate limits vary by model; Patches retries on 429/503, then tries fallbacks in SUPPORTED_MODELS.
// Get a key at https://aistudio.google.com/apikey
//
// Models (set PATCHES_MODEL in .env to override) — use ListModels if one 404s for your key/region:
//   gemini-2.5-flash          — default
//   gemini-2.5-pro            — stronger / different quota pool
//   gemini-2.0-flash          — Gemini 2 Flash
//   gemini-2.0-flash-lite     — Gemini 2 Flash Lite

const SYSTEM_PROMPT = `You are an expert CSS engineer whose sole job is to write CSS patches for websites.

OUTPUT FORMAT (mandatory):
Return exactly one JSON object, no markdown fences, no text before or after. Shape:
{"aspects":[{"label":"short human-readable name","css":"valid CSS rules here"}]}
- Use one aspect for a single cohesive change (one theme, one feature).
- Use multiple aspects when the user asked for clearly separate changes (e.g. "dark mode and larger font" → one aspect for dark backgrounds/text colors, one for font-size/line-height) so they can be toggled independently later.
- Each "css" value must be complete valid CSS with selectors and braces; put !important on declarations that must override the site.

TYPOGRAPHY — "larger font", "bigger text", etc.:
- Do NOT set html { font-size: 18px } or 20px+ unless the user explicitly asks for very large text. That rem-scales the entire UI and looks broken.
- Prefer a **modest** bump: html { font-size: 106% !important; } to html { font-size: 112% !important; }, OR body { font-size: 1.0625rem !important; }, OR body { zoom: 1.06 !important; } (Chrome), staying roughly in the 5–12% range.
- If the snapshot shows specific content areas, you may target those instead of the whole page.

DARK MODE — "dark mode", "dark theme", etc.:
- Dark mode means **readable contrast**: near-white text on near-black backgrounds sitewide.
- Always set dark page background on html, body (e.g. #0f0f0f, #121212, #181818) AND set light foreground text (e.g. #e8eaed, #f1f1f1) on body and on common text containers.
- Many sites leave text dark after background changes: add broad rules so text is light, e.g. body, #content, main, article, p, span, h1, h2, h3, h4, div[role="main"] { color: #e8eaed !important; } plus site-specific tags from the snapshot (e.g. ytd-* on YouTube). Style links distinctly (e.g. a { color: #8ab4f8 !important; }) so they stay visible.
- Override common "stuck dark text" by targeting classes/ids from the snapshot and * where needed for color (use carefully).

HIDE SIDEBAR / PANEL / RAIL:
- Use display: none !important; on the narrow column hosts. Prefer selectors from LAYOUT_HINTS and PAGE_OUTLINE (ids like #guide, #sidebar).
- Custom elements (e.g. ytd-mini-guide-renderer) are **hosts**: hiding the host hides the entire subtree including shadow DOM. Prefer ytd-mini-guide-renderer, ytd-guide-renderer, #guide, #guide-wrapper when present in hints.
- If one selector fails, combine several likely selectors with comma-separated rules.

RULES for the CSS inside each aspect:
1. Use the most specific selectors possible from LAYOUT_HINTS, PAGE_OUTLINE, class names and IDs.
2. Hide elements with: display: none !important;
3. If the request is ambiguous, cover the most likely interpretations in that aspect's CSS.

COLOR / PALETTE CHANGES (blues→reds, brand recolor, etc.):
The HTML snapshot does NOT show colors from external stylesheets or computed styles—only structure, classes, and sometimes inline attributes. Many "blue" UIs are styled via CSS files you cannot see.
- For broad "change blues to reds" / recolor requests: include rules on html or body using filter, e.g. filter: hue-rotate(-140deg) saturate(1.1) !important; and -webkit-filter with the same (tune degrees until blue shifts toward red/orange). Label that aspect clearly (e.g. "Global hue shift") so the user knows it affects the whole page including images.
- ALSO add selector-based overrides using classes/ids from the snapshot for color, background-color, border-color, fill, stroke where it helps.
- Prefer not to rely on guessing hex codes from the snapshot alone; combine filter + targeted selectors.

Never put prose outside the JSON. Never use markdown code fences around the JSON.`;

function domainPatchHints(domain) {
  if (domain === 'youtube.com') {
    return `SITE-SPECIFIC (youtube.com):
- Left nav: ytd-mini-guide-renderer, ytd-guide-renderer, #guide, #guide-wrapper, #guide-inner-content, #guide-content. Hiding the host (e.g. ytd-mini-guide-renderer { display: none !important; }) hides the whole column including shadow DOM. Prefer selectors listed as PRESENT in LAYOUT_HINTS.
- Dark mode: YouTube uses theme flags (often html[dark] or similar) and many ytd-* tags. After darkening backgrounds, force light text on body, #content, #primary, #secondary, and common ytd-* text containers so UI stays readable.\n\n`;
  }
  return '';
}

async function generateCSSFromPrompt(prompt, rawHTML, domain) {
  if (!GEMINI_API_KEY)
    throw new Error('GEMINI_API_KEY not set. Add it to your .env file and restart.');

  const domSnapshot = rawHTML && rawHTML.length > 80
    ? rawHTML.slice(0, 14000)
    : trimDOM(rawHTML || '');

  const hints = domainPatchHints(domain || '');
  const userText = `TASK: ${prompt}\n\n${hints}PAGE STRUCTURE (LAYOUT_HINTS list which major containers exist; PAGE_OUTLINE is a tree of tags with id/class/role):\n${domSnapshot}\n\nRespond with only the JSON object described in your instructions.`;

  const generated = await callGeminiGenerateContent({
    apiKey: GEMINI_API_KEY,
    preferredModel: GEMINI_MODEL,
    supportedModels: SUPPORTED_MODELS,
    systemText: SYSTEM_PROMPT,
    userText,
    generationConfig: {
      temperature:     0.2,
      topP:            0.9,
      maxOutputTokens: 2048,
    },
  });

  return {
    aspects: parseModelAspects(generated.text),
    usedModel: generated.usedModel,
    fallbackUsed: generated.fallbackUsed,
    fallbackError: generated.fallbackError,
  };
}
// ── Page understanding (sticky notes) — separate from CSS patches ─────────────
function pageHelpersSource() {
  const files = ['buildPageOutline.js', 'stickyNotes.js'];
  return files.map((f) => fs.readFileSync(path.join(__dirname, 'page', f), 'utf-8')).join('\n;\n');
}

function serializeNotesDebug(value, max = 40000) {
  if (value == null) return '';
  let text = typeof value === 'string' ? value : '';
  if (!text) {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  if (text.length > max) return `${text.slice(0, max)}…[truncated]`;
  return text;
}

function notesDebugPayload(err, extra) {
  const debug = {
    geminiAuth: (err && err.notesDebug && err.notesDebug.geminiAuth)
      || (err && err.geminiAuth)
      || 'x-goog-api-key header via callGeminiGenerateContent (not ?key=)',
    requestUrl: (err && err.notesDebug && err.notesDebug.requestUrl) || (err && err.requestUrl) || '',
    finishReason: (err && err.notesDebug && err.notesDebug.finishReason) || (err && err.finishReason) || '',
    rawGeminiBody: serializeNotesDebug(
      (err && err.notesDebug && err.notesDebug.rawGeminiBody) || (err && err.rawGeminiBody) || ''
    ),
    error: err ? String(err.message || err) : '',
    stack: err && err.stack ? String(err.stack) : '',
    ...(extra || {}),
  };
  console.error('[patches:notes] failure debug', debug);
  return debug;
}

async function injectPageHelpers() {
  if (!browserView) return;
  await browserView.webContents.executeJavaScript(`${pageHelpersSource()}\n;true;`);
}

function emitNotesStatus(extra) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const domain = getDomain(currentURL);
  const lastPrompt = pageNotesStore ? pageNotesStore.getLastPrompt(domain) : '';
  mainWindow.webContents.send('page-notes-status', {
    domain,
    phase: notesPhase,
    lastPrompt,
    ...(extra || {}),
  });
}

function canPromptExtract(domain) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const times = (notesPromptHours[domain] || []).filter((t) => t > hourAgo);
  notesPromptHours[domain] = times;
  if (times.length >= MAX_NOTES_PROMPTS_PER_HOUR) return { ok: false, reason: 'hourly-cap' };
  return { ok: true };
}

function recordPromptExtract(domain) {
  notesPromptHours[domain] = [...(notesPromptHours[domain] || []), Date.now()];
}

async function unmountPageNotes() {
  if (!browserView) return;
  await browserView.webContents.executeJavaScript(`
    try { window.unmountPatchesStickyNotes(); } catch (e) {}
  `).catch(() => {});
}

async function runPageUnderstanding({ prompt, reason }) {
  if (!isAuthenticated || !browserView || !pageNotesStore) {
    return { success: false, error: 'Sign in to create page notes.' };
  }
  const domain = getDomain(currentURL);
  let text = String(prompt || '').trim();
  if (!text && reason === 'refresh') text = pageNotesStore.getLastPrompt(domain);
  if (!text) {
    notesPhase = 'error';
    const error = reason === 'refresh' ? 'No previous notes prompt to re-run on this site.' : 'Enter a notes request.';
    emitNotesStatus({ error });
    return { success: false, error };
  }

  const gate = canPromptExtract(domain);
  if (!gate.ok) {
    notesPhase = 'capped';
    const error = `Hourly notes limit reached for ${domain} (${MAX_NOTES_PROMPTS_PER_HOUR}/hour). Try again later.`;
    emitNotesStatus({ error, capReason: gate.reason });
    return { success: false, error };
  }

  if (notesExtractInFlight) {
    return { success: false, error: 'A notes request is already running.' };
  }
  if (!String(GEMINI_API_KEY || '').trim()) {
    notesPhase = 'error';
    const error = 'Add a Gemini API key in Settings to create page notes.';
    emitNotesStatus({ error });
    return { success: false, needsApiKey: true, error };
  }

  notesExtractInFlight = true;
  notesPhase = 'reading';
  emitNotesStatus({ lastPrompt: text });
  try {
    await injectPageHelpers();
    const outline = await browserView.webContents.executeJavaScript('window.buildPageOutline()');
    if (!outline || typeof outline !== 'object') {
      throw new Error('Could not read a page outline from this document.');
    }
    notesPhase = 'sending';
    emitNotesStatus();
    const extracted = await extractNotableItems({
      outline,
      userPrompt: text,
      callGemini: ({ systemText, userText, generationConfig }) =>
        callGeminiGenerateContent({
          apiKey: GEMINI_API_KEY,
          preferredModel: GEMINI_MODEL,
          supportedModels: SUPPORTED_MODELS,
          systemText,
          userText,
          generationConfig,
        }),
    });
    recordPromptExtract(domain);
    pageNotesStore.setLastPrompt(domain, text);
    const positions = pageNotesStore.getPositions(domain);
    const items = (extracted.items || []).map((item, i) => ({
      ...item,
      id: `n-${item.anchorIndex}-${i}`,
    }));
    const payloadJson = JSON.stringify({ items, positions });
    await injectPageHelpers();
    const mounted = await browserView.webContents.executeJavaScript(`
      (function() {
        try {
          if (typeof window.mountPatchesStickyNotes !== 'function') {
            throw new Error('mountPatchesStickyNotes is not defined');
          }
          window.mountPatchesStickyNotes(JSON.parse(${JSON.stringify(payloadJson)}));
          return { ok: true };
        } catch (e) {
          return {
            ok: false,
            error: String(e && e.message ? e.message : e),
            stack: String(e && e.stack ? e.stack : ''),
          };
        }
      })();
    `);
    if (!mounted || mounted.ok === false) {
      const err = new Error((mounted && mounted.error) || 'Failed to mount sticky notes.');
      err.notesDebug = {
        ...(extracted.debug || {}),
        finishReason: extracted.debug && extracted.debug.finishReason,
        pageError: mounted && mounted.error,
        pageStack: mounted && mounted.stack,
      };
      throw err;
    }
    notesPhase = 'idle';
    emitNotesStatus({ itemCount: items.length, lastPrompt: text });
    return { success: true, domain, itemCount: items.length, usedModel: extracted.usedModel };
  } catch (err) {
    notesPhase = 'error';
    const debug = notesDebugPayload(err, err.notesDebug || {});
    emitNotesStatus({ error: err.message || String(err), debug });
    return {
      success: false,
      error: err.message || String(err),
      debug,
      geminiQuota: Boolean(err.geminiQuota),
      errorDetail: err.geminiErrorDetail || err.message,
    };
  } finally {
    notesExtractInFlight = false;
  }
}

// ── BrowserView ───────────────────────────────────────────────────────────────
function createBrowserView() {
  if (browserView || !mainWindow) return;
  browserView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'pagePreload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });
  mainWindow.addBrowserView(browserView);
  layoutBrowserView();
  browserView.webContents.loadURL(currentURL);

  browserView.webContents.on('did-finish-load', async () => {
    const url = browserView.webContents.getURL();
    currentURL = url;
    mainWindow.webContents.send('url-changed', url);
    await applyDomainPatches(url);
    emitNotesStatus();
  });
  browserView.webContents.on('did-navigate', (_, url) => {
    currentURL = url;
    mainWindow.webContents.send('url-changed', url);
    emitNotesStatus();
  });
  browserView.webContents.on('did-navigate-in-page', (_, url) => {
    currentURL = url;
    mainWindow.webContents.send('url-changed', url);
    emitNotesStatus();
  });
  browserView.webContents.on('page-title-updated', (_, title) => {
    mainWindow.webContents.send('title-changed', title);
  });
}

function layoutBrowserView() {
  if (!browserView || !mainWindow) return;
  const [w, h] = mainWindow.getContentSize();
  if (commandOverlayOpen) {
    browserView.setBounds({ x: 0, y: h, width: w, height: 0 });
    return;
  }
  const side = patchesPanelOpen ? PATCHES_PANEL_WIDTH : 0;
  const bwW = Math.max(120, w - side);
  browserView.setBounds({ x: 0, y: NAV_BAR_HEIGHT, width: bwW, height: h - NAV_BAR_HEIGHT });
}

// ── Main window ───────────────────────────────────────────────────────────────
function destroyBrowserView() {
  if (!browserView || !mainWindow) return;
  mainWindow.removeBrowserView(browserView);
  browserView.webContents.destroy();
  browserView = null;
}

function unlockAppAfterAuth() {
  if (!mainWindow) return;
  createBrowserView();
  mainWindow.webContents.send('auth-ready');
  if (!GEMINI_API_KEY) openSettingsWindow();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 900, minWidth: 800, minHeight: 600,
    show: false,
    backgroundColor: '#0a0a0f',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: 'persist:patches-auth',
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isAuthenticated) unlockAppAfterAuth();
  });
  mainWindow.on('resize', layoutBrowserView);
}

// ── IPC — Auth & Firebase ─────────────────────────────────────────────────────
ipcMain.handle('get-firebase-config', () => ({
  configured: isFirebaseConfigured(),
  webConfig: getFirebaseWebConfig(),
}));

ipcMain.handle('auth-established', async (_, { uid, email, displayName, idToken, patches }) => {
  const local = loadPatchesFromDisk();
  const merged = mergePatchesPreferCloud(patches, local);
  patchesStore = merged;
  writePatchesToDisk(merged);

  authUser = { uid, email: email || '', displayName: displayName || '' };
  isAuthenticated = true;
  patchesCloudSync = true;

  const hadBrowser = Boolean(browserView);
  if (!hadBrowser) unlockAppAfterAuth();
  else if (browserView) await applyDomainPatches(currentURL);

  const shouldUploadLocal = !Object.keys(patches || {}).length && Object.keys(local).length > 0;
  if (shouldUploadLocal && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-patches-to-cloud', merged);
  }

  return { success: true, user: authUser };
});

ipcMain.handle('auth-signed-out', async () => {
  isAuthenticated = false;
  authUser = null;
  patchesCloudSync = false;
  patchesStore = loadPatchesFromDisk();
  destroyBrowserView();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth-required');
  }
  return { success: true };
});

ipcMain.handle('get-auth-user', () => ({
  isAuthenticated,
  user: authUser,
}));

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('navigate', async (_, url) => {
  if (!isAuthenticated || !browserView) return currentURL;
  let target = url.trim();
  if (!target.startsWith('http://') && !target.startsWith('https://'))
    target = target.includes('.') ? `https://${target}` : `https://www.google.com/search?q=${encodeURIComponent(target)}`;
  browserView.webContents.loadURL(target);
  currentURL = target;
  return target;
});

ipcMain.handle('go-back',    () => browserView?.webContents.canGoBack()    && browserView.webContents.goBack());
ipcMain.handle('go-forward', () => browserView?.webContents.canGoForward() && browserView.webContents.goForward());
ipcMain.handle('reload',     () => browserView?.webContents.reload());
ipcMain.handle('get-current-url', () => currentURL);
ipcMain.handle('get-model',       () => GEMINI_MODEL);
ipcMain.handle('get-supported-models', () => SUPPORTED_MODELS);
ipcMain.handle('set-model', (_, { model }) => {
  const next = String(model || '').trim();
  if (!SUPPORTED_MODELS.includes(next)) {
    return { success: false, error: 'Unsupported model.' };
  }
  GEMINI_MODEL = next;
  process.env.PATCHES_MODEL = GEMINI_MODEL;
  upsertUserEnv({ PATCHES_MODEL: GEMINI_MODEL });
  return { success: true, model: GEMINI_MODEL };
});

// Toggle overlay: shrink BrowserView so the renderer overlay is actually visible
ipcMain.handle('set-overlay-open', (_, { open }) => {
  commandOverlayOpen = !!open;
  layoutBrowserView();
});

ipcMain.handle('set-patches-panel-open', (_, { open }) => {
  patchesPanelOpen = !!open;
  layoutBrowserView();
});

ipcMain.handle('apply-patch', async (_, { prompt }) => {
  if (!isAuthenticated || !browserView) {
    return { success: false, error: 'Sign in to create patches.' };
  }
  if (!String(GEMINI_API_KEY || '').trim()) {
    return {
      success: false,
      needsApiKey: true,
      error: 'Add a Gemini API key in Settings to create patches with AI.',
    };
  }
  try {
    const rawHTML = await browserView.webContents.executeJavaScript(`
  (function(){
    try {
      function layoutHints() {
        var lines = [];
        var sels = [
          '#guide', '#guide-wrapper', '#guide-inner-content', '#guide-content', '#guide-button',
          'ytd-mini-guide-renderer', 'ytd-guide-renderer', 'ytd-app',
          '#primary', '#secondary', '#content', '#columns', '#masthead', 'ytd-masthead',
          '#sidebar', 'aside[role="complementary"]', '[data-testid="sidebar"]'
        ];
        for (var i = 0; i < sels.length; i++) {
          try {
            var el = document.querySelector(sels[i]);
            if (el) lines.push('PRESENT ' + sels[i] + ' <' + el.tagName.toLowerCase() + '>');
          } catch (e) {}
        }
        return lines.join(String.fromCharCode(10));
      }
      // Walk the DOM and emit a structural outline with id/class/role signals
      function outline(el, depth) {
        if (depth > 8) return '';
        const tag = el.tagName.toLowerCase();
        const id    = el.id    ? ' id="'    + el.id    + '"' : '';
        const cls   = el.className && typeof el.className === 'string'
                      ? ' class="' + el.className.trim().slice(0, 80) + '"' : '';
        const role  = el.getAttribute('role')       ? ' role="'       + el.getAttribute('role')       + '"' : '';
        const label = el.getAttribute('aria-label') ? ' aria-label="' + el.getAttribute('aria-label') + '"' : '';
        const text  = el.childElementCount === 0
                      ? el.innerText.trim().slice(0, 60).replace(/\\n/g,' ')
                      : '';
        const children = Array.from(el.children).map(c => outline(c, depth+1)).join('');
        return '<' + tag + id + cls + role + label + '>'
             + (text ? text : children)
             + '</' + tag + '>';
      }
      var hints = layoutHints();
      var tree = outline(document.body, 0);
      var nl = String.fromCharCode(10);
      var combined = (hints ? 'LAYOUT_HINTS:' + nl + hints + nl + nl + 'PAGE_OUTLINE:' + nl : 'PAGE_OUTLINE:' + nl) + tree;
      return combined.slice(0, 12000);
    } catch(e) { return document.body.innerHTML.slice(0, 5000); }
  })();
`).catch(() => '');

    const generated = await generateCSSFromPrompt(prompt, rawHTML, getDomain(currentURL));
    const aspects = generated.aspects.map((a, i) => ({
      id:      String(i),
      label:   a.label,
      css:     a.css,
      enabled: true,
    }));
    const css = aspects.map((a) => a.css).join('\n');
    const domain = getDomain(currentURL);
    const patches = loadPatches();
    if (!patches[domain]) patches[domain] = [];
    const idx = patches[domain].length;
    patches[domain].push({ prompt, css, aspects, createdAt: Date.now() });
    savePatches(patches);
    await injectCSS(css, `patches-${idx}`);
    return {
      success: true,
      css,
      domain,
      aspects,
      usedModel: generated.usedModel,
      fallbackUsed: generated.fallbackUsed,
      fallbackError: generated.fallbackError,
    };
  } catch (err) {
    if (err.geminiQuota) {
      return {
        success: false,
        geminiQuota: true,
        error:
          'Gemini quota or rate limit reached. Use your own API key, try another model, or wait and retry.',
        errorDetail: err.geminiErrorDetail || err.message,
      };
    }
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-patches', () => {
  const list = loadPatches()[getDomain(currentURL)] || [];
  return list.map((p) => normalisePatch(p));
});

ipcMain.handle('reset-domain-patches', async () => {
  const domain = getDomain(currentURL);
  const patches = loadPatches();
  patches[domain] = [];
  savePatches(patches);
  await removeAllInjectedCSS();
  await applyDomainPatches(currentURL);
  return [];
});

ipcMain.handle('set-patch-aspect-enabled', async (_, { patchIndex, aspectId, enabled }) => {
  const domain = getDomain(currentURL);
  const patches = loadPatches();
  const list = patches[domain];
  if (!list || patchIndex < 0 || patchIndex >= list.length) return list || [];
  const patch = normalisePatch(list[patchIndex]);
  const asp = patch.aspects.find((a) => a.id === String(aspectId));
  if (asp) asp.enabled = !!enabled;
  list[patchIndex] = {
    ...list[patchIndex],
    prompt: patch.prompt,
    createdAt: patch.createdAt,
    aspects: patch.aspects,
    css: patch.aspects.map((a) => a.css).join('\n'),
  };
  savePatches(patches);
  await removeAllInjectedCSS();
  await applyDomainPatches(currentURL);
  return list.map((p) => normalisePatch(p));
});

ipcMain.handle('delete-patch', async (_, { index }) => {
  const domain  = getDomain(currentURL);
  const patches = loadPatches();
  if (patches[domain]) {
    patches[domain].splice(index, 1);
    savePatches(patches);
    await removeAllInjectedCSS();
    await applyDomainPatches(currentURL);
  }
  return patches[domain] || [];
});

ipcMain.handle('toggle-patches', async (_, { enabled }) => {
  patchesEnabled = enabled;
  if (enabled) await applyDomainPatches(currentURL);
  else         await removeAllInjectedCSS();
  return patchesEnabled;
});

ipcMain.handle('open-settings', () => {
  openSettingsWindow();
  return { success: true };
});

ipcMain.handle('open-external', async (_, { url }) => {
  if (!url || typeof url !== 'string') return { success: false };
  await shell.openExternal(url);
  return { success: true };
});

ipcMain.handle('get-api-key-status', () => {
  const key = String(process.env.GEMINI_API_KEY || GEMINI_API_KEY || '').trim();
  const hasKey = isValidGeminiApiKey(key);
  const maskedKey = hasKey && key.length > 8
    ? `${key.slice(0, 4)}...${key.slice(-4)}`
    : hasKey ? key : '';
  return { hasKey, key: hasKey ? key : '', maskedKey, model: GEMINI_MODEL, supportedModels: SUPPORTED_MODELS };
});

ipcMain.handle('save-api-key', async (_, { key }) => {
  const value = String(key || '').trim();
  if (!value) return { success: false, error: 'API key is required.' };
  if (!isValidGeminiApiKey(value)) return { success: false, error: geminiKeyFormatError() };

  upsertUserEnv({ GEMINI_API_KEY: value, PATCHES_MODEL: GEMINI_MODEL });
  app.relaunch();
  app.exit(0);
  return { success: true };
});

ipcMain.handle('get-page-notes-state', () => {
  const domain = getDomain(currentURL);
  const lastPrompt = pageNotesStore ? pageNotesStore.getLastPrompt(domain) : '';
  return { domain, phase: notesPhase, lastPrompt };
});

ipcMain.handle('apply-page-notes', async (_, { prompt }) => {
  return runPageUnderstanding({ prompt, reason: 'prompt' });
});

ipcMain.handle('refresh-page-notes', async () => {
  return runPageUnderstanding({ reason: 'refresh' });
});

ipcMain.on('note-position', (_, payload) => {
  if (!pageNotesStore || !payload) return;
  const domain = getDomain(currentURL);
  const noteId = String(payload.noteId || '').trim();
  if (!noteId) return;
  pageNotesStore.savePosition(domain, noteId, payload.x, payload.y);
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  loadDotEnv();
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = getAppIconPath();
    if (iconPath) app.dock.setIcon(iconPath);
  }
  patchesStore = loadPatchesFromDisk();
  pageNotesStore = createPageNotesStore(app.getPath('userData'));
  const loadedKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (loadedKey && !isValidGeminiApiKey(loadedKey)) {
    console.warn('[patches] GEMINI_API_KEY format not recognized (expected AQ. or AIza). Ignoring.');
    delete process.env.GEMINI_API_KEY;
    GEMINI_API_KEY = '';
  } else {
    GEMINI_API_KEY = loadedKey;
  }
  GEMINI_MODEL = process.env.PATCHES_MODEL || GEMINI_MODEL;
  if (!SUPPORTED_MODELS.includes(GEMINI_MODEL)) {
    GEMINI_MODEL = SUPPORTED_MODELS[0];
    process.env.PATCHES_MODEL = GEMINI_MODEL;
  }

  createWindow();

  // Global shortcut fires even when BrowserView has focus
  globalShortcut.register('CommandOrControl+K', () => {
    if (mainWindow && isAuthenticated) mainWindow.webContents.send('toggle-command-bar');
  });
  globalShortcut.register('CommandOrControl+Shift+N', () => {
    if (mainWindow && isAuthenticated) mainWindow.webContents.send('toggle-notes-bar');
  });
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    if (mainWindow && isAuthenticated) mainWindow.webContents.send('toggle-patches-panel');
  });
  globalShortcut.register('CommandOrControl+,', () => {
    if (isAuthenticated) openSettingsWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    createWindow();
  });
});

app.on('will-quit',        () => globalShortcut.unregisterAll());
app.on('window-all-closed',() => { if (process.platform !== 'darwin') app.quit(); });
