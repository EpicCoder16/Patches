'use strict';

window.unmountPatchesStickyNotes = function unmountPatchesStickyNotes() {
  const host = document.getElementById('patches-notes-host');
  if (host) host.remove();
};

window.mountPatchesStickyNotes = function mountPatchesStickyNotes(payload) {
  window.unmountPatchesStickyNotes();
  const items = (payload && payload.items) || [];
  const positions = (payload && payload.positions) || {};
  if (!items.length) return { ok: true, itemCount: 0 };

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
    '.note { position: fixed; width: 220px; pointer-events: auto; background: #f7e7a1; color: #1a1a14; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.28); overflow: hidden; }',
    '.head { display: flex; align-items: center; gap: 6px; padding: 8px 10px 6px; cursor: grab; background: rgba(0,0,0,0.06); user-select: none; }',
    '.head:active { cursor: grabbing; }',
    '.type { font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.65; }',
    '.title { font-size: 12px; font-weight: 650; flex: 1; line-height: 1.25; }',
    '.body { padding: 6px 10px 10px; font-size: 11.5px; line-height: 1.4; opacity: 0.9; }',
    '.imp { font-size: 10px; opacity: 0.5; padding: 0 10px 8px; }',
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

  function defaultPos(item, i) {
    const target = document.querySelector('[data-patches-anchor="' + item.anchorIndex + '"]');
    if (target) {
      const r = target.getBoundingClientRect();
      return {
        x: Math.min(window.innerWidth - 236, Math.max(8, r.right + 8)),
        y: Math.min(window.innerHeight - 80, Math.max(8, r.top)),
      };
    }
    return { x: 16, y: 16 + i * 88 };
  }

  function flashAnchor(index) {
    const target = document.querySelector('[data-patches-anchor="' + index + '"]');
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prev = target.style.outline;
    target.style.outline = '3px solid #6e6af0';
    setTimeout(function () { target.style.outline = prev; }, 900);
  }

  items.forEach(function (item, i) {
    const id = item.id || ('n-' + item.anchorIndex + '-' + i);
    const saved = positions[id];
    const pos = saved && Number.isFinite(saved.x) ? saved : defaultPos(item, i);

    const note = el('div', 'note');
    note.style.left = pos.x + 'px';
    note.style.top = pos.y + 'px';

    const head = el('div', 'head');
    head.appendChild(el('span', 'type', item.type || 'note'));
    head.appendChild(el('span', 'title', item.title || ''));
    const body = el('div', 'body', item.snippet || '');
    const imp = el('div', 'imp', 'Importance ' + (item.importance || ''));
    note.appendChild(head);
    note.appendChild(body);
    note.appendChild(imp);

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
        window.patchesPage.saveNotePosition({ noteId: id, x: x, y: y });
      }
    });

    note.addEventListener('click', function (e) {
      if (moved) { moved = false; e.preventDefault(); return; }
      flashAnchor(item.anchorIndex);
    });

    layer.appendChild(note);
  });

  return { ok: true, itemCount: items.length };
};
