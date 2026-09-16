'use strict';

/**
 * Runs in the BrowserView page. Returns a capped, redacted outline.
 * Stamps visible candidate blocks with data-patches-anchor for later note targeting.
 */
window.buildPageOutline = function buildPageOutline() {
  const MAX_INNER_TEXT = 8000;
  const MAX_ANCHORS = 80;
  const MAX_PREVIEW = 80;
  const MAX_META = 140;
  const MIN_BLOCK_CHARS = 18;
  const SENSITIVE_RE = /password|passwd|credit|cardnum|card-number|cc-|cc_|cvv|cvc|ssn|iban|routing|account.?num|expir|pin\b|otp|secret|token|cvv2|csc/i;

  function isSensitiveField(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false;
    const type = String(el.type || '').toLowerCase();
    if (type === 'password' || type === 'hidden') return true;
    if (type === 'email' || type === 'tel') return true;
    const blob = [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.placeholder]
      .filter(Boolean)
      .join(' ');
    return SENSITIVE_RE.test(blob);
  }

  function redactSensitiveValues() {
    const restored = [];
    const nodes = document.querySelectorAll('input, textarea, select');
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!isSensitiveField(el)) continue;
      if (el.tagName.toLowerCase() === 'select') {
        restored.push({ el, kind: 'select', value: el.value });
        try { el.selectedIndex = -1; } catch (e) { el.value = ''; }
      } else {
        restored.push({ el, kind: 'value', value: el.value });
        el.value = '';
      }
    }
    return restored;
  }

  function restoreSensitiveValues(restored) {
    for (let i = 0; i < restored.length; i++) {
      const item = restored[i];
      try { item.el.value = item.value; } catch (e) {}
    }
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    const st = window.getComputedStyle(el);
    if (!st || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    return true;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function previewOf(el, max) {
    return normalizeText(el.innerText || el.textContent || '').slice(0, max || MAX_PREVIEW);
  }

  function titlePreview(el) {
    const heading = el.querySelector(
      'h1,h2,h3,h4,a#video-title,#video-title,yt-formatted-string#video-title,[id="video-title"],a[title]'
    );
    if (heading) {
      const t = previewOf(heading, MAX_PREVIEW);
      if (t) return t;
    }
    const labeled = el.getAttribute('aria-label');
    if (labeled) return normalizeText(labeled).slice(0, MAX_PREVIEW);
    const lines = normalizeText(el.innerText || '').split(/(?<=\.) | · | \| /);
    return (lines[0] || previewOf(el, MAX_PREVIEW)).slice(0, MAX_PREVIEW);
  }

  function looksLikeMeta(text) {
    if (!text || text.length < 2 || text.length > 80) return false;
    return /(\d[\d,.]*\s*(views?|watching|subscribers?|likes?|sold|ratings?))|\$\s?\d|€\s?\d|£\s?\d|\d+\s*%|\d+\s*(hours?|hrs?|days?|weeks?|months?|years?|minutes?|mins?)\s*ago|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?|\bstreamed|\bpremiere|\bago\b/i.test(text);
  }

  function nearbyMeta(el, title) {
    const bits = [];
    const seen = new Set();
    function add(text) {
      const t = normalizeText(text);
      if (!t || t === title || seen.has(t)) return;
      if (t.length > 80) return;
      seen.add(t);
      bits.push(t);
    }

    const times = el.querySelectorAll('time, [datetime]');
    for (let i = 0; i < times.length && bits.length < 6; i++) {
      add(times[i].getAttribute('datetime') || previewOf(times[i], 40));
    }

    const metaNodes = el.querySelectorAll(
      'span, yt-formatted-string, [class*="meta"], [class*="view"], [class*="count"], [class*="price"], [class*="date"], [id*="metadata"]'
    );
    for (let i = 0; i < metaNodes.length && bits.length < 8; i++) {
      const t = previewOf(metaNodes[i], 60);
      if (looksLikeMeta(t)) add(t);
    }

    let sib = el.nextElementSibling;
    for (let n = 0; n < 2 && sib; n++) {
      const t = previewOf(sib, 60);
      if (looksLikeMeta(t) || (t && t.length <= 40 && /\d/.test(t))) add(t);
      sib = sib.nextElementSibling;
    }

    const parent = el.parentElement;
    if (parent && bits.length < 4) {
      const extras = parent.querySelectorAll('span, yt-formatted-string');
      for (let i = 0; i < extras.length && bits.length < 8; i++) {
        if (el.contains(extras[i])) continue;
        const t = previewOf(extras[i], 50);
        if (looksLikeMeta(t)) add(t);
      }
    }

    if (!bits.length) {
      const rest = normalizeText(el.innerText || '');
      if (title && rest.indexOf(title) === 0) {
        const leftover = rest.slice(title.length).trim();
        leftover.split(/ · | \| /).forEach((part) => {
          if (looksLikeMeta(part)) add(part);
        });
      }
    }

    return bits.join(' · ').slice(0, MAX_META);
  }

  function isListish(el) {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (tag === 'li' || tag === 'article' || role === 'listitem' || role === 'article') return true;
    if (tag.indexOf('video') !== -1 || tag.indexOf('rich-item') !== -1 || tag.indexOf('playlist') !== -1) return true;
    return false;
  }

  function clearOldAnchors() {
    const old = document.querySelectorAll('[data-patches-anchor]');
    for (let i = 0; i < old.length; i++) old[i].removeAttribute('data-patches-anchor');
  }

  const restored = redactSensitiveValues();
  let innerText = '';
  try {
    innerText = String(document.body && document.body.innerText ? document.body.innerText : '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_INNER_TEXT);
  } catch (e) {
    innerText = '';
  }

  const landmarks = [];
  const landmarkSel = 'h1,h2,h3,h4,h5,h6,article,section,time,[role="article"],[role="listitem"],[role="heading"],[role="main"]';
  try {
    const lms = document.querySelectorAll(landmarkSel);
    for (let i = 0; i < lms.length && landmarks.length < 80; i++) {
      const el = lms[i];
      if (!isVisible(el)) continue;
      landmarks.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        datetime: el.getAttribute('datetime') || '',
        preview: previewOf(el, 60),
      });
    }
  } catch (e) {}

  clearOldAnchors();
  const anchors = [];
  const candidateSel = [
    'article', 'section', 'li', '[role="listitem"]', '[role="article"]', '[role="heading"]',
    'h1', 'h2', 'h3', 'h4', 'p', 'time', 'td', 'blockquote',
    'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-grid-video-renderer',
    'ytd-compact-video-renderer', 'ytd-playlist-video-renderer',
  ].join(',');
  const seen = new Set();
  try {
    const nodes = document.querySelectorAll(candidateSel);
    for (let i = 0; i < nodes.length && anchors.length < MAX_ANCHORS; i++) {
      const el = nodes[i];
      if (seen.has(el) || !isVisible(el)) continue;
      let skip = false;
      let p = el.parentElement;
      while (p) {
        if (p.hasAttribute && p.hasAttribute('data-patches-anchor')) { skip = true; break; }
        p = p.parentElement;
      }
      if (skip) continue;
      const preview = titlePreview(el);
      if (preview.length < MIN_BLOCK_CHARS) continue;
      const index = anchors.length;
      el.setAttribute('data-patches-anchor', String(index));
      seen.add(el);
      const meta = isListish(el) ? nearbyMeta(el, preview) : nearbyMeta(el, preview);
      anchors.push({
        index,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        preview,
        meta: meta || '',
      });
    }
  } catch (e) {}

  restoreSensitiveValues(restored);

  return {
    title: String(document.title || '').slice(0, 200),
    innerText,
    landmarks,
    anchors,
    truncated: innerText.length >= MAX_INNER_TEXT || anchors.length >= MAX_ANCHORS,
  };
}
