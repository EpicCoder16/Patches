'use strict';

/**
 * Sticky notes (runs in the BrowserView page).
 *
 * Renders ONE grouped note per prompt. Payload shape:
 *   { type, title, items: [{ id, title, snippet, importance, anchorIndex }], positions }
 * Each list entry keeps its own anchorIndex; clicking an entry scrolls to that
 * item's [data-patches-anchor] element and flashes it.
 *
 * mountPatchesStickyNotes() returns { ok, itemCount, anchorAudit } where
 * anchorAudit rows are { anchorIndex, found, itemText, anchorPreview } — used by
 * main.js to log render-time anchor resolution (diagnoses notes stacking at top).
 */

window.unmountPatchesStickyNotes = function unmountPatchesStickyNotes() {
  const host = document.getElementById('patches-notes-host');
  if (host) host.remove();
};

window.mountPatchesStickyNotes = function mountPatchesStickyNotes(payload) {
  window.unmountPatchesStickyNotes();

  const items = (payload && Array.isArray(payload.items)) ? payload.items : [];
  const positions = (payload && payload.positions) || {};
  const groupType = String((payload && payload.type) || 'notes');
  const groupTitle = String((payload && payload.title) || 'Notes');

  // ── Render-time anchor audit ─────────────────────────────────────────────
  // Does each item's anchor element still exist when the note mounts? If the
  // target page re-rendered between buildPageOutline() and the Gemini response,
  // the stamped [data-patches-anchor] nodes are gone and entries lose their
  // scroll targets (the clump-at-top bug).
  const anchorAudit = items.map(function (item) {
    const idx = Number(item.anchorIndex);
    const target = Number.isFinite(idx)
      ? document.querySelector('[data-patches-anchor="' + idx + '"]')
      : null;
    return {
      anchorIndex: idx,
      found: !!target,
      itemText: String(item.title || ''),
      anchorPreview: target ? '' : String(item.title || ''),
    };
  });

  if (!items.length) return { ok: true, itemCount: 0, anchorAudit: anchorAudit };

  const host = document.createElement('div');
  host.id = 'patches-notes-host';
  host.setAttribute('data-patches-ui', 'notes');
  host.style.all = 'initial';
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.zIndex = '2147483646';
  host.style.pointerEvents = 'none';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = [
    ':host { all: initial; }',
    '.layer { position: fixed; inset: 0; pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }',
    '.note { position: fixed; width: 260px; max-height: 70vh; pointer-events: auto; background: #f7e7a1; color: #1a1a14; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.28); overflow: hidden; display: flex; flex-direction: column; }',
    '.head { display: flex; align-items: center; gap: 6px; padding: 8px 10px 6px; cursor: grab; background: rgba(0,0,0,0.06); user-select: none; }',
    '.head:active { cursor: grabbing; }',
    '.type { font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.65; flex-shrink: 0; }',
    '.title { font-size: 12px; font-weight: 650; flex: 1; line-height: 1.25; }',
    '.list { overflow-y: auto; padding: 2px 0 4px; }',
    '.item { padding: 7px 10px; border-top: 1px solid rgba(0,0,0,0.08); cursor: pointer; }',
    '.item:first-child { border-top: none; }',
    '.item:hover { background: rgba(0,0,0,0.05); }',
    '.item-title { font-size: 11.5px; font-weight: 650; line-height: 1.3; }',
    '.item-snippet { font-size: 11px; line-height: 1.35; opacity: 0.85; margin-top: 1px; }',
    '.item-imp { font-size: 10px; opacity: 0.5; margin-top: 2px; }',
    '.empty { padding: 8px 10px 10px; font-size: 11px; opacity: 0.7; }',
  ].join('\n');
  shadow.appendChild(style);

  const layer = document.createElement('div');
  layer.className = 'layer';
  shadow.appendChild(layer);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function flashAnchor(index) {
    const target = document.querySelector('[data-patches-anchor="' + index + '"]');
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prev = target.style.outline;
    target.style.outline = '3px solid #6e6af0';
    setTimeout(function () { target.style.outline = prev; }, 900);
  }

  const note = el('div', 'note');
  const savedGroupPos = positions.__group;
  note.style.left = (savedGroupPos && Number.isFinite(savedGroupPos.x) ? savedGroupPos.x : 16) + 'px';
  note.style.top = (savedGroupPos && Number.isFinite(savedGroupPos.y) ? savedGroupPos.y : 16) + 'px';

  const head = el('div', 'head');
  head.appendChild(el('span', 'type', groupType));
  head.appendChild(el('span', 'title', groupTitle));
  note.appendChild(head);

  const list = el('div', 'list');
  if (!items.length) {
    list.appendChild(el('div', 'empty', 'No matching items on this page.'));
  }
  items.forEach(function (item) {
    const row = el('div', 'item');
    row.appendChild(el('div', 'item-title', item.title || ''));
    if (item.snippet) row.appendChild(el('div', 'item-snippet', item.snippet));
    if (item.importance != null) row.appendChild(el('div', 'item-imp', 'Importance ' + item.importance));
    row.addEventListener('click', function () {
      flashAnchor(item.anchorIndex);
    });
    list.appendChild(row);
  });
  note.appendChild(list);
  layer.appendChild(note);

  // Drag by the header; save under __group so re-renders keep the user's spot.
  let dragging = false;
  let moved = false;
  let dx = 0;
  let dy = 0;
  head.addEventListener('pointerdown', function (e) {
    dragging = true;
    moved = false;
    dx = e.clientX - note.offsetLeft;
    dy = e.clientY - note.offsetTop;
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  head.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    const x = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - dx));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy));
    if (Math.abs(e.clientX - dx - note.offsetLeft) > 2 || Math.abs(e.clientY - dy - note.offsetTop) > 2) {
      moved = true;
    }
    note.style.left = x + 'px';
    note.style.top = y + 'px';
  });
  head.addEventListener('pointerup', function (e) {
    if (!dragging) return;
    dragging = false;
    try { head.releasePointerCapture(e.pointerId); } catch (err) {}
    const x = parseFloat(note.style.left) || 0;
    const y = parseFloat(note.style.top) || 0;
    if (window.patchesPage && typeof window.patchesPage.saveNotePosition === 'function') {
      window.patchesPage.saveNotePosition({ noteId: '__group', x: x, y: y });
    }
  });

  return { ok: true, itemCount: items.length, anchorAudit: anchorAudit };
};
