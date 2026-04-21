'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const urlInput        = document.getElementById('url-input');
const btnBack         = document.getElementById('btn-back');
const btnForward      = document.getElementById('btn-forward');
const btnReload       = document.getElementById('btn-reload');
const btnOpenBar      = document.getElementById('btn-open-bar');
const btnPatchesPanel = document.getElementById('btn-patches-panel');
const btnSettings     = document.getElementById('btn-settings');
const patchToggle     = document.getElementById('patch-toggle');

const cmdOverlay      = document.getElementById('cmd-overlay');
const cmdInput        = document.getElementById('cmd-input');
const cmdSubmit       = document.getElementById('cmd-submit');
const cmdStatus       = document.getElementById('cmd-status');
const cmdDomainBadge  = document.getElementById('cmd-domain-badge');
const cmdModelBadge   = document.getElementById('cmd-model-badge');
const cmdHints        = document.getElementById('cmd-hints');
const cmdBackdrop     = document.getElementById('cmd-backdrop');

const patchesPanel    = document.getElementById('patches-panel');
const patchesList     = document.getElementById('patches-list');
const patchesEmpty    = document.getElementById('patches-empty');
const panelDomain     = document.getElementById('panel-domain');
const panelResetSite  = document.getElementById('panel-reset-site');
const panelClose      = document.getElementById('panel-close');

const toastContainer  = document.getElementById('toast-container');

// ── State ─────────────────────────────────────────────────────────────────────
let cmdBarOpen       = false;
let patchesPanelOpen = false;
let isLoading        = false;
let currentURL       = '';

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

function showToast(message, type = 'success') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-dot"></span><span>${message}</span>`;
  toastContainer.appendChild(t);
  setTimeout(() => {
    t.classList.add('removing');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  }, 2800);
}

function escapeHTML(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── URL bar ───────────────────────────────────────────────────────────────────
function updateURLBar(url) {
  currentURL = url;
  urlInput.value = url;
  cmdDomainBadge.textContent = getDomain(url);
  if (patchesPanelOpen) panelDomain.textContent = getDomain(url);
}

urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    window.patches.navigate(urlInput.value).then(u => updateURLBar(u));
    urlInput.blur();
  }
  if (e.key === 'Escape') urlInput.blur();
});
urlInput.addEventListener('focus', () => urlInput.select());

// ── Nav buttons ───────────────────────────────────────────────────────────────
btnBack.addEventListener('click',    () => window.patches.goBack());
btnForward.addEventListener('click', () => window.patches.goForward());
btnReload.addEventListener('click',  () => window.patches.reload());
btnOpenBar.addEventListener('click', () => openCommandBar());
btnPatchesPanel.addEventListener('click', () => togglePatchesPanel());
btnSettings.addEventListener('click', () => window.patches.openSettings());

patchToggle.addEventListener('change', async () => {
  await window.patches.togglePatches({ enabled: patchToggle.checked });
  showToast(patchToggle.checked ? 'Patches enabled' : 'Patches disabled');
});

// ── Command bar ───────────────────────────────────────────────────────────────
async function openCommandBar() {
  if (cmdBarOpen) return;
  if (patchesPanelOpen) {
    patchesPanelOpen = false;
    patchesPanel.classList.add('hidden');
    await window.patches.setPatchesPanelOpen({ open: false });
  }
  cmdBarOpen = true;
  // Tell main to shrink the BrowserView so our overlay is actually visible
  await window.patches.setOverlayOpen({ open: true });
  cmdOverlay.classList.remove('hidden');
  cmdInput.value = '';
  setStatusHidden();
  setTimeout(() => cmdInput.focus(), 30);
}

async function closeCommandBar() {
  if (!cmdBarOpen) return;
  cmdBarOpen = false;
  cmdOverlay.classList.add('hidden');
  cmdInput.blur();
  isLoading = false;
  // Restore BrowserView to full size
  await window.patches.setOverlayOpen({ open: false });
}

cmdBackdrop.addEventListener('click', () => closeCommandBar());

cmdInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeCommandBar(); return; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitPatch(); }
});
cmdSubmit.addEventListener('click', submitPatch);

// Hint chips
cmdHints.querySelectorAll('.hint').forEach(chip => {
  chip.addEventListener('click', () => {
    cmdInput.value = chip.textContent.replace(/"/g, '');
    cmdInput.focus();
    submitPatch();
  });
});

// ── Status helpers ────────────────────────────────────────────────────────────
function setStatusHidden() {
  cmdStatus.className = 'hidden';
  cmdStatus.innerHTML = '';
}
function setStatusLoading(text) {
  cmdStatus.className = 'loading';
  cmdStatus.innerHTML = `<div class="spinner"></div><span>${text}</span>`;
}
function setStatusSuccess(prompt, css) {
  cmdStatus.className = 'success';
  cmdStatus.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 7l3 3 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span>Applied <strong>"${escapeHTML(prompt)}"</strong></span>
    <span class="status-css">${escapeHTML(css)}</span>`;
}
function setStatusError(msg) {
  cmdStatus.className = 'error';
  cmdStatus.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v5.5M7 9.5v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    <span>${escapeHTML(msg)}</span>`;
}

function setStatusGeminiQuota(summary, detail) {
  const det = String(detail || '').trim();
  const detShort = det.length > 900 ? `${det.slice(0, 900)}…` : det;
  cmdStatus.className = 'error quota';
  cmdStatus.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="cmd-status-icon"><path d="M7 2v5.5M7 9.5v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    <div class="cmd-status-quota-wrap">
      <div class="cmd-status-quota-text">
        <strong class="cmd-status-quota-title">Gemini quota or rate limit</strong>
        <p class="cmd-status-quota-body">${escapeHTML(summary || 'Your API key hit a quota or rate limit.')}</p>
        <div class="cmd-status-quota-actions">
          <button type="button" class="cmd-status-open-settings">Open Settings</button>
        </div>
      </div>
      ${detShort ? `<details class="cmd-status-details"><summary>Technical details</summary><pre class="cmd-status-details-pre">${escapeHTML(detShort)}</pre></details>` : ''}
    </div>`;
  const openBtn = cmdStatus.querySelector('.cmd-status-open-settings');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      window.patches.openSettings();
    });
  }
}

// ── Submit patch ──────────────────────────────────────────────────────────────
async function submitPatch() {
  const prompt = cmdInput.value.trim();
  if (!prompt || isLoading) return;

  isLoading = true;
  cmdInput.disabled = true;
  cmdSubmit.disabled = true;
  setStatusLoading('Generating CSS patch…');

  try {
    const result = await window.patches.applyPatch({ prompt });
    if (result.success) {
      setStatusSuccess(prompt, result.css);
      cmdInput.value = '';
      showToast(`Patch applied on ${result.domain}`);
      if (patchesPanelOpen) await refreshPatchesPanel();
      setTimeout(() => closeCommandBar(), 1600);
    } else if (result.geminiQuota) {
      setStatusGeminiQuota(result.error, result.errorDetail);
    } else {
      setStatusError(result.error || 'Something went wrong.');
    }
  } catch (err) {
    setStatusError(err.message || 'Unexpected error.');
  } finally {
    isLoading = false;
    cmdInput.disabled = false;
    cmdSubmit.disabled = false;
    if (cmdBarOpen) cmdInput.focus();
  }
}

// ── Patches panel ─────────────────────────────────────────────────────────────
async function togglePatchesPanel() {
  patchesPanelOpen = !patchesPanelOpen;
  if (patchesPanelOpen) {
    if (cmdBarOpen) await closeCommandBar();
    patchesPanel.classList.remove('hidden');
    panelDomain.textContent = getDomain(currentURL);
    await window.patches.setPatchesPanelOpen({ open: true });
    await refreshPatchesPanel();
  } else {
    patchesPanel.classList.add('hidden');
    await window.patches.setPatchesPanelOpen({ open: false });
  }
}
panelClose.addEventListener('click', async () => {
  patchesPanelOpen = false;
  patchesPanel.classList.add('hidden');
  await window.patches.setPatchesPanelOpen({ open: false });
});

panelResetSite.addEventListener('click', async () => {
  const d = getDomain(currentURL);
  if (!confirm(`Remove all saved patches for ${d}?`)) return;
  await window.patches.resetDomainPatches();
  showToast(`Patches cleared for ${d}`);
  await refreshPatchesPanel();
});

async function refreshPatchesPanel() {
  const list = await window.patches.getPatches();
  patchesList.innerHTML = '';
  if (list.length === 0) { patchesEmpty.classList.remove('hidden'); return; }
  patchesEmpty.classList.add('hidden');

  list.forEach((patch, i) => {
    const aspects = patch.aspects && patch.aspects.length
      ? patch.aspects
      : [{ id: '0', label: 'Styles', css: patch.css || '', enabled: true }];
    const aspectsHtml = aspects.map((a) => `
      <label class="patch-aspect-row">
        <input type="checkbox" class="patch-aspect-toggle" data-patch-index="${i}" data-aspect-id="${escapeHTML(String(a.id))}" ${a.enabled !== false ? 'checked' : ''} />
        <span class="patch-aspect-label">${escapeHTML(a.label)}</span>
      </label>
    `).join('');
    const previewCss = aspects.filter((a) => a.enabled !== false).map((a) => a.css).join('\n') || patch.css || '';
    const card = document.createElement('div');
    card.className = 'patch-card';
    card.innerHTML = `
      <div class="patch-card-prompt">${escapeHTML(patch.prompt)}</div>
      <div class="patch-aspects">${aspectsHtml}</div>
      <div class="patch-card-css" title="${escapeHTML(previewCss)}">${escapeHTML(previewCss.slice(0, 200))}${previewCss.length > 200 ? '…' : ''}</div>
      <div class="patch-card-actions">
        <button type="button" class="patch-delete-btn" data-index="${i}">Remove patch</button>
      </div>`;
    patchesList.appendChild(card);
  });

  patchesList.querySelectorAll('.patch-aspect-toggle').forEach((el) => {
    el.addEventListener('change', async () => {
      const input = el;
      await window.patches.setPatchAspectEnabled({
        patchIndex: parseInt(input.dataset.patchIndex, 10),
        aspectId: input.dataset.aspectId,
        enabled: input.checked,
      });
      await refreshPatchesPanel();
    });
  });

  patchesList.querySelectorAll('.patch-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.patches.deletePatch({ index: parseInt(btn.dataset.index, 10) });
      showToast('Patch removed');
      await refreshPatchesPanel();
    });
  });
}

// ── IPC listeners ─────────────────────────────────────────────────────────────
window.patches.onURLChanged(url => updateURLBar(url));
window.patches.onTitleChanged(() => {});
window.patches.onToggleCommandBar(() => { cmdBarOpen ? closeCommandBar() : openCommandBar(); });
window.patches.onTogglePatchesPanel(() => togglePatchesPanel());

// ── Keyboard shortcuts (renderer window) ──────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    cmdBarOpen ? closeCommandBar() : openCommandBar();
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'P') {
    e.preventDefault();
    togglePatchesPanel();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault();
    window.patches.openSettings();
  }
  if (e.key === 'Escape' && cmdBarOpen) closeCommandBar();
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const [url, model] = await Promise.all([
    window.patches.getCurrentURL(),
    window.patches.getModel(),
  ]);
  updateURLBar(url);
  // Show the short model name (everything after the last /)
  if (cmdModelBadge) {
    cmdModelBadge.textContent = model;
    cmdModelBadge.title = model;
  }
})();
