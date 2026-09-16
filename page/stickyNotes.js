'use strict';

window.unmountPatchesStickyNotes = function unmountPatchesStickyNotes() {
  const host = document.getElementById('patches-notes-host');
  if (host) host.remove();
};

window.mountPatchesStickyNotes = function mountPatchesStickyNotes(payload) {
  window.unmountPatchesStickyNotes();
  const groups = (payload && payload.groups) || [];
  const positions = (payload && payload.positions) || {};
  if (!groups.length) return { ok: true, itemCount: 0, groupCount: 0, anchorResolution: [] };

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
    '.note { position: fixed; width: 260px; pointer-events: auto; background: #f7e7a1; color: #1a1a14; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.28); overflow: hidden; }',
    '.head { padding: 8px 10px; cursor: grab; background: rgba(0,0,0,0.06); user-select: none; }',
    '.head:active { cursor: grabbing; }',
    '.group-title { font-size: 12px; font-weight: 650; line-height: 1.25; }',
    '.items { margin: 0; padding: 4px 10px 8px; list-style: none; }',
    '.item { padding: 6px 0; border-top: 1px solid rgba(0,0,0,0.1); cursor: pointer; }',
    '.item-title { font-size: 11.5px; font-weight: 650; line-height: 1.35; }',
    '.item-snippet { margin-top: 2px; font-size: 11px; line-height: 1.35; opacity: 0.78; }',
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

  function anchorFor(index) {
    return document.querySelector('[data-patches-anchor="' + index + '"]');
  }

  function defaultPos(group, i) {
    const items = Array.isArray(group.items) ? group.items : [];
    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      const target = anchorFor(items[itemIndex].anchorIndex);
      if (!target) continue;
      const r = target.getBoundingClientRect();
      return {
        x: Math.min(window.innerWidth - 276, Math.max(8, r.right + 8)),
        y: Math.min(window.innerHeight - 80, Math.max(8, r.top)),
      };
    }
    return { x: 16, y: 16 + i * 88 };
  }

  function flashAnchor(index) {
    const target = anchorFor(index);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prev = target.style.outline;
    target.style.outline = '3px solid #6e6af0';
    setTimeout(function () { target.style.outline = prev; }, 900);
  }

  const anchorResolution = [];
  groups.forEach(function (group, groupIndex) {
    const items = Array.isArray(group.items) ? group.items.slice() : [];
    items.sort(function (a, b) { return (b.importance || 0) - (a.importance || 0); });
    items.forEach(function (item, itemIndex) {
      const found = Boolean(anchorFor(item.anchorIndex));
      const resolution = {
        groupIndex,
        itemIndex,
        anchorIndex: item.anchorIndex,
        found,
        title: item.title || '',
      };
      anchorResolution.push(resolution);
      console.log('[patches:notes] anchor resolution', resolution);
    });

    const id = group.id || ('g-' + groupIndex);
    const saved = positions[id];
    const pos = saved && Number.isFinite(saved.x) ? saved : defaultPos({ ...group, items }, groupIndex);

    const note = el('div', 'note');
    note.style.left = pos.x + 'px';
    note.style.top = pos.y + 'px';

    const head = el('div', 'head');
    head.appendChild(el('div', 'group-title', group.groupTitle || 'Notes'));
    note.appendChild(head);

    const list = el('ul', 'items');
    items.forEach(function (item) {
      const entry = el('li', 'item');
      entry.appendChild(el('div', 'item-title', item.title || ''));
      if (item.snippet) entry.appendChild(el('div', 'item-snippet', item.snippet));
      entry.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        flashAnchor(item.anchorIndex);
      });
      list.appendChild(entry);
    });
    note.appendChild(list);

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

    layer.appendChild(note);
  });

  return {
    ok: true,
    itemCount: anchorResolution.length,
    groupCount: groups.length,
    anchorResolution,
  };
};
