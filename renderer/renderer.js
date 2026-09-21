'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const urlInput        = document.getElementById('url-input');
const btnBack         = document.getElementById('btn-back');
const btnForward      = document.getElementById('btn-forward');
const btnReload       = document.getElementById('btn-reload');
const btnOpenBar      = document.getElementById('btn-open-bar');
const btnOpenNotes    = document.getElementById('btn-open-notes');
const btnPatchesPanel = document.getElementById('btn-patches-panel');
const btnSettings     = document.getElementById('btn-settings');
const patchToggle     = document.getElementById('patch-toggle');

const cmdOverlay      = document.getElementById('cmd-overlay');
const cmdInput        = document.getElementById('cmd-input');
const cmdSubmit       = document.getElementById('cmd-submit');
const cmdStatus       = document.getElementById('cmd-status');
const cmdDomainBadge  = document.getElementById('cmd-domain-badge');
const cmdModelSelect  = document.getElementById('cmd-model-select');
const cmdHints        = document.getElementById('cmd-hints');
const cmdBackdrop     = document.getElementById('cmd-backdrop');

const patchesPanel    = document.getElementById('patches-panel');
const patchesList     = document.getElementById('patches-list');
const patchesEmpty    = document.getElementById('patches-empty');
const panelDomain     = document.getElementById('panel-domain');
const panelResetSite  = document.getElementById('panel-reset-site');
const panelClose      = document.getElementById('panel-close');

const toastContainer  = document.getElementById('toast-container');
const navApiHint      = document.getElementById('nav-api-hint');
const navApiHintBtn   = document.getElementById('nav-api-hint-settings');
const navUserEmail    = document.getElementById('nav-user-email');
const btnSignOut      = document.getElementById('btn-sign-out');
const navNotes        = document.getElementById('nav-notes');
const navNotesLabel   = document.getElementById('nav-notes-label');
const navNotesRefresh = document.getElementById('nav-notes-refresh');

// ── State ─────────────────────────────────────────────────────────────────────
let overlayKind      = 'patch';
let cmdBarOpen       = false;
let patchesPanelOpen = false;
let isLoading        = false;
let currentURL       = '';
const queuedPrompts  = [];
let availableModels  = [];
let appBooted        = false;

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

function applyNotesState(state) {
  if (!navNotes || !state) return;
  const phase = state.phase || 'idle';
  navNotes.dataset.phase = phase;
  const domain = state.domain || getDomain(currentURL);
  const labels = {
    idle: state.lastPrompt ? 'Notes ready' : 'Notes idle',
    reading: 'Reading page…',
    sending: 'Sending to Gemini…',
    capped: 'Notes paused (hourly cap)',
    error: 'Notes error',
  };
  navNotesLabel.textContent = labels[phase] || 'Notes idle';
  if (navNotesRefresh) {
    if (state.lastPrompt) navNotesRefresh.classList.remove('hidden');
    else navNotesRefresh.classList.add('hidden');
  }
  navNotes.title = state.error
    ? String(state.error)
    : phase === 'sending' || phase === 'reading'
      ? `Visible page text on ${domain} is being sent to Gemini for sticky notes.`
      : state.lastPrompt
        ? `Last notes prompt on ${domain}: ${state.lastPrompt}`
        : `Ask AI to pin notes on ${domain}`;
}

if (navNotesRefresh) {
  navNotesRefresh.addEventListener('click', async () => {
    setStatusLoading('Re-running last notes prompt…');
    const result = await window.patches.refreshPageNotes();
    if (!result || !result.success) {
      setStatusNotesError(
        (result && result.error) || 'Could not refresh notes',
        result && result.debug
      );
      showToast((result && result.error) || 'Could not refresh notes', 'error');
    } else {
      showToast(`Updated notes — ${result.itemCount || 0} items`);
    }
  });
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLikelyHighDemand(errorText) {
  return /high demand|rate.?limit|resource_exhausted|too many requests|try again later|quota exceeded/i.test(
    String(errorText || '')
  );
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
btnOpenBar.addEventListener('click', () => openCommandBar('patch'));
if (btnOpenNotes) btnOpenNotes.addEventListener('click', () => openCommandBar('notes'));
btnPatchesPanel.addEventListener('click', () => togglePatchesPanel());
btnSettings.addEventListener('click', () => window.patches.openSettings());

patchToggle.addEventListener('change', async () => {
  await window.patches.togglePatches({ enabled: patchToggle.checked });
  showToast(patchToggle.checked ? 'Patches enabled' : 'Patches disabled');
});

cmdModelSelect.addEventListener('change', async () => {
  const model = cmdModelSelect.value;
  const result = await window.patches.setModel(model);
  if (!result || !result.success) {
    showToast((result && result.error) || 'Failed to switch model', 'error');
    return;
  }
  cmdModelSelect.title = model;
  showToast(`Model switched to ${model}`);
});

// ── Command bar ───────────────────────────────────────────────────────────────
function syncOverlayKind(kind) {
  overlayKind = kind === 'notes' ? 'notes' : 'patch';
  if (cmdInput) {
    cmdInput.placeholder = overlayKind === 'notes'
      ? 'What should notes show? “popular videos”, “due this week”…'
      : 'Describe a change… "hide sidebar", "dark mode", "remove ads"';
  }
  if (cmdHints) {
    cmdHints.querySelectorAll('.hint').forEach((chip) => {
      const forKind = chip.getAttribute('data-kind') || 'patch';
      chip.classList.toggle('hidden', forKind !== overlayKind);
    });
  }
}

async function openCommandBar(kind = 'patch') {
  if (cmdBarOpen && overlayKind === (kind === 'notes' ? 'notes' : 'patch')) return;
  if (cmdBarOpen) await closeCommandBar();
  if (patchesPanelOpen) {
    patchesPanelOpen = false;
    patchesPanel.classList.add('hidden');
    await window.patches.setPatchesPanelOpen({ open: false });
  }
  cmdBarOpen = true;
  syncOverlayKind(kind);
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

function setStatusNotesError(msg, debug) {
  const raw = debug && (debug.rawGeminiBody || debug.stack)
    ? [debug.finishReason && `finishReason: ${debug.finishReason}`, debug.geminiAuth, debug.requestUrl, debug.error, debug.stack, debug.rawGeminiBody]
        .filter(Boolean)
        .join('\n\n')
    : '';
  const detShort = raw.length > 4000 ? `${raw.slice(0, 4000)}…` : raw;
  cmdStatus.className = 'error quota';
  cmdStatus.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="cmd-status-icon"><path d="M7 2v5.5M7 9.5v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    <div class="cmd-status-quota-wrap">
      <div class="cmd-status-quota-text">
        <strong class="cmd-status-quota-title">Notes failed</strong>
        <p class="cmd-status-quota-body">${escapeHTML(msg || 'Could not create notes.')}</p>
      </div>
      ${detShort ? `<details class="cmd-status-details" open><summary>Gemini debug</summary><pre class="cmd-status-details-pre">${escapeHTML(detShort)}</pre></details>` : ''}
    </div>`;
}

function setStatusNeedsApiKey() {
  cmdStatus.className = 'error quota';
  cmdStatus.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="cmd-status-icon"><path d="M7 2v5.5M7 9.5v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    <div class="cmd-status-quota-wrap">
      <div class="cmd-status-quota-text">
        <strong class="cmd-status-quota-title">Gemini API key required</strong>
        <p class="cmd-status-quota-body">Add your free key in Settings to generate patches with AI. Saved patches for this site still apply without a key.</p>
        <div class="cmd-status-quota-actions">
          <button type="button" class="cmd-status-open-settings">Open Settings</button>
        </div>
      </div>
    </div>`;
  const openBtn = cmdStatus.querySelector('.cmd-status-open-settings');
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      window.patches.openSettings();
    });
  }
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
async function submitNotes(prompt) {
  if (isLoading) {
    queuedPrompts.push({ prompt, kind: 'notes' });
    cmdInput.value = '';
    setStatusLoading(`Creating notes… (${queuedPrompts.length} queued)`);
    showToast(`Queued notes request (${queuedPrompts.length})`);
    return;
  }

  isLoading = true;
  cmdInput.disabled = true;
  cmdSubmit.disabled = true;
  setStatusLoading('Reading page and sending to Gemini…');

  try {
    cmdInput.value = '';
    const result = await window.patches.applyPageNotes({ prompt });
    if (result && result.success) {
      setStatusSuccess(prompt, `${result.itemCount || 0} notes`);
      showToast(`Pinned a note with ${result.itemCount || 0} items on ${result.domain || 'this page'}`);
      setTimeout(() => closeCommandBar(), 1600);
      return;
    }
    if (result && result.needsApiKey) {
      setStatusNeedsApiKey();
      return;
    }
    if (result && result.geminiQuota) {
      setStatusGeminiQuota(result.error, result.errorDetail || (result.debug && result.debug.rawGeminiBody));
      return;
    }
    setStatusNotesError((result && result.error) || 'Could not create notes.', result && result.debug);
  } catch (err) {
    setStatusNotesError(err.message || 'Unexpected error.', { stack: err.stack, error: err.message });
  } finally {
    isLoading = false;
    cmdInput.disabled = false;
    cmdSubmit.disabled = false;
    if (queuedPrompts.length > 0) {
      const next = queuedPrompts.shift();
      overlayKind = next && next.kind ? next.kind : 'patch';
      syncOverlayKind(overlayKind);
      cmdInput.value = next && next.prompt ? next.prompt : String(next || '');
      setTimeout(() => submitPatch(), 80);
      return;
    }
    if (cmdBarOpen) cmdInput.focus();
  }
}

async function submitPatch() {
  const prompt = cmdInput.value.trim();
  if (!prompt) return;
  if (overlayKind === 'notes') {
    await submitNotes(prompt);
    return;
  }
  if (isLoading) {
    queuedPrompts.push({ prompt, kind: 'patch' });
    cmdInput.value = '';
    setStatusLoading(`Generating CSS patch… (${queuedPrompts.length} queued)`);
    showToast(`Queued patch (${queuedPrompts.length})`);
    return;
  }

  isLoading = true;
  cmdInput.disabled = true;
  cmdSubmit.disabled = true;
  setStatusLoading('Generating CSS patch…');

  try {
    cmdInput.value = '';
    let lastResult = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await window.patches.applyPatch({ prompt });
      lastResult = result;

      if (result.success) {
        setStatusSuccess(prompt, result.css);
        showToast(`Patch applied on ${result.domain}`);
        if (result.fallbackUsed && result.usedModel) {
          showToast(`High demand on selected model. Used ${result.usedModel} fallback.`);
        }
        if (patchesPanelOpen) await refreshPatchesPanel();
        setTimeout(() => closeCommandBar(), 1600);
        return;
      }

      if (result.needsApiKey) {
        setStatusNeedsApiKey();
        break;
      }

      if (
        result.geminiQuota &&
        isLikelyHighDemand(result.errorDetail || result.error) &&
        attempt < 3
      ) {
        const delayMs = attempt === 1 ? 1500 : 3000;
        setStatusLoading(
          `Model is in high demand. Retrying in ${Math.round(delayMs / 1000)}s… (${attempt}/3)`
        );
        await sleep(delayMs);
        continue;
      }

      break;
    }

    if (lastResult?.geminiQuota) {
      setStatusGeminiQuota(lastResult.error, lastResult.errorDetail);
    } else if (isLikelyHighDemand(lastResult?.errorDetail || lastResult?.error)) {
      setStatusGeminiQuota(
        'Model is experiencing high demand. You can wait and retry, or switch to a lighter model in Settings.',
        lastResult?.errorDetail || lastResult?.error
      );
    } else {
      setStatusError(lastResult?.error || 'Something went wrong.');
    }
  } catch (err) {
    setStatusError(err.message || 'Unexpected error.');
  } finally {
    isLoading = false;
    cmdInput.disabled = false;
    cmdSubmit.disabled = false;

    if (queuedPrompts.length > 0) {
      const next = queuedPrompts.shift();
      overlayKind = next && next.kind ? next.kind : 'patch';
      syncOverlayKind(overlayKind);
      cmdInput.value = next && next.prompt ? next.prompt : String(next || '');
      setTimeout(() => submitPatch(), 80);
      return;
    }

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
window.patches.onURLChanged(url => {
  updateURLBar(url);
  window.patches.getPageNotesState().then(applyNotesState).catch(() => {});
});
window.patches.onTitleChanged(() => {});
window.patches.onPageNotesStatus((state) => applyNotesState(state));
window.patches.onToggleCommandBar(() => { cmdBarOpen ? closeCommandBar() : openCommandBar('patch'); });
window.patches.onToggleNotesBar(() => { cmdBarOpen && overlayKind === 'notes' ? closeCommandBar() : openCommandBar('notes'); });
window.patches.onTogglePatchesPanel(() => togglePatchesPanel());

// ── Keyboard shortcuts (renderer window) ──────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    cmdBarOpen ? closeCommandBar() : openCommandBar('patch');
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
    e.preventDefault();
    cmdBarOpen && overlayKind === 'notes' ? closeCommandBar() : openCommandBar('notes');
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

function updateAuthNav(user) {
  if (!user) {
    if (navUserEmail) navUserEmail.classList.add('hidden');
    if (btnSignOut) btnSignOut.classList.add('hidden');
    return;
  }
  if (navUserEmail) {
    navUserEmail.textContent = user.email || 'Signed in';
    navUserEmail.classList.remove('hidden');
  }
  if (btnSignOut) btnSignOut.classList.remove('hidden');
}

async function bootApp() {
  if (appBooted) return;
  appBooted = true;
  const [url, model, supportedModels, keyState, authState, notesState] = await Promise.all([
    window.patches.getCurrentURL(),
    window.patches.getModel(),
    window.patches.getSupportedModels(),
    window.patches.getApiKeyStatus(),
    window.patches.getAuthUser(),
    window.patches.getPageNotesState(),
  ]);
  updateURLBar(url);
  applyNotesState(notesState);
  updateAuthNav(authState?.user);
  if (navApiHint && keyState && !keyState.hasKey) {
    navApiHint.classList.remove('hidden');
  }
  if (navApiHintBtn) {
    navApiHintBtn.addEventListener('click', () => window.patches.openSettings());
  }
  availableModels = Array.isArray(supportedModels) ? supportedModels : [];
  if (cmdModelSelect) {
    cmdModelSelect.innerHTML = '';
    for (const m of availableModels) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      cmdModelSelect.appendChild(opt);
    }
    cmdModelSelect.value = model;
    cmdModelSelect.title = model;
  }
}

if (btnSignOut) {
  btnSignOut.addEventListener('click', async () => {
    if (!confirm('Sign out of Patches?')) return;
    await window.patches.signOut();
    appBooted = false;
    updateAuthNav(null);
    showToast('Signed out');
  });
}

window.patches.onAuthReady(() => {
  document.body.classList.remove('auth-locked');
  bootApp().catch(() => {});
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const authState = await window.patches.getAuthUser();
  if (authState?.isAuthenticated) {
    document.body.classList.remove('auth-locked');
    await bootApp();
  }
})();
