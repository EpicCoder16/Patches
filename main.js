const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

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

// ── Config ────────────────────────────────────────────────────────────────────
const NAV_BAR_HEIGHT     = 48;
// Must match #patches-panel width in renderer/style.css
const PATCHES_PANEL_WIDTH = 300;
let GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = process.env.PATCHES_MODEL || 'gemini-2.0-flash';
// Gemini endpoint — model is injected into the URL, key as query param
const GEMINI_URL     = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

let mainWindow   = null;
let browserView  = null;
let currentURL   = 'https://www.youtube.com/';
let patchesEnabled = true;
let commandOverlayOpen = false;
let patchesPanelOpen   = false;

// ── Storage ───────────────────────────────────────────────────────────────────
function getPatchesFilePath() {
  if (app.isPackaged) return path.join(app.getPath('userData'), 'patches.json');
  return path.join(__dirname, 'storage', 'patches.json');
}

function loadPatches() {
  const patchesFile = getPatchesFilePath();
  try { return JSON.parse(fs.readFileSync(patchesFile, 'utf-8')); }
  catch { return {}; }
}
function savePatches(patches) {
  const patchesFile = getPatchesFilePath();
  fs.mkdirSync(path.dirname(patchesFile), { recursive: true });
  fs.writeFileSync(patchesFile, JSON.stringify(patches, null, 2), 'utf-8');
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
// Free tier (AI Studio key): 15 req/min, 1500 req/day on gemini-2.0-flash.
// Get a key at https://aistudio.google.com/apikey
//
// Models (set PATCHES_MODEL in .env to override):
//   gemini-2.0-flash          — default, fast, generous free tier
//   gemini-2.0-flash-lite     — even faster / lighter
//   gemini-1.5-flash          — slightly slower but very capable
//   gemini-1.5-flash-8b       — smallest / cheapest

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

  // Gemini uses a single "contents" array; system instruction is separate.
  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{
      role: 'user',
      parts: [{ text: userText }],
    }],
    generationConfig: {
      temperature:     0.2,
      topP:            0.9,
      maxOutputTokens: 2048,
    },
  };

  const res = await fetch(GEMINI_URL(GEMINI_MODEL), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }).catch(e => { throw new Error(`Network error: ${e.message}`); });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    throw new Error(`Gemini ${res.status}: ${msg}`);
  }

  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    const reason = data?.candidates?.[0]?.finishReason || 'unknown';
    throw new Error(`Empty response from Gemini (finishReason: ${reason}).`);
  }

  return parseModelAspects(raw);
}
// ── BrowserView ───────────────────────────────────────────────────────────────
function createBrowserView() {
  browserView = new BrowserView({
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false },
  });
  mainWindow.addBrowserView(browserView);
  layoutBrowserView();
  browserView.webContents.loadURL(currentURL);

  browserView.webContents.on('did-finish-load', async () => {
    const url = browserView.webContents.getURL();
    currentURL = url;
    mainWindow.webContents.send('url-changed', url);
    await applyDomainPatches(url);
  });
  browserView.webContents.on('did-navigate', (_, url) => {
    currentURL = url;
    mainWindow.webContents.send('url-changed', url);
  });
  browserView.webContents.on('did-navigate-in-page', (_, url) => {
    currentURL = url;
    mainWindow.webContents.send('url-changed', url);
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
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 900, minWidth: 800, minHeight: 600,
    backgroundColor: '#0a0a0f',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); createBrowserView(); });
  mainWindow.on('resize', layoutBrowserView);
}

async function showMissingApiKeyDialog() {
  const envPath = getPreferredEnvPath();
  const envDir = path.dirname(envPath);
  await dialog.showMessageBox({
    type: 'warning',
    title: 'GEMINI_API_KEY missing',
    message: 'Patches needs a GEMINI_API_KEY to generate CSS patches.',
    detail: [
      'Create a .env file with this line:',
      'GEMINI_API_KEY=your_api_key_here',
      '',
      `Place it at: ${envPath}`
    ].join('\n'),
    buttons: ['Open Folder', 'OK'],
    defaultId: 0,
    cancelId: 1,
  });
  await shell.openPath(envDir);
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('navigate', async (_, url) => {
  let target = url.trim();
  if (!target.startsWith('http://') && !target.startsWith('https://'))
    target = target.includes('.') ? `https://${target}` : `https://www.google.com/search?q=${encodeURIComponent(target)}`;
  browserView.webContents.loadURL(target);
  currentURL = target;
  return target;
});

ipcMain.handle('go-back',    () => browserView.webContents.canGoBack()    && browserView.webContents.goBack());
ipcMain.handle('go-forward', () => browserView.webContents.canGoForward() && browserView.webContents.goForward());
ipcMain.handle('reload',     () => browserView.webContents.reload());
ipcMain.handle('get-current-url', () => currentURL);
ipcMain.handle('get-model',       () => GEMINI_MODEL);

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

    const aspectDefs = await generateCSSFromPrompt(prompt, rawHTML, getDomain(currentURL));
    const aspects = aspectDefs.map((a, i) => ({
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
    return { success: true, css, domain, aspects };
  } catch (err) {
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

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  loadDotEnv();
  GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

  createWindow();
  if (!GEMINI_API_KEY) showMissingApiKeyDialog().catch(() => {});

  // Global shortcut fires even when BrowserView has focus
  globalShortcut.register('CommandOrControl+K', () => {
    if (mainWindow) mainWindow.webContents.send('toggle-command-bar');
  });
  globalShortcut.register('CommandOrControl+Shift+P', () => {
    if (mainWindow) mainWindow.webContents.send('toggle-patches-panel');
  });

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit',        () => globalShortcut.unregisterAll());
app.on('window-all-closed',() => { if (process.platform !== 'darwin') app.quit(); });
