'use strict';

const fs = require('fs');
const path = require('path');

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function createPageNotesStore(userDataPath) {
  const metaPath = path.join(userDataPath, 'page-understanding.json');
  const positionsPath = path.join(userDataPath, 'notes-positions.json');

  function loadMeta() {
    const data = readJson(metaPath, {});
    return data && typeof data === 'object' ? data : {};
  }

  function getLastPrompt(domain) {
    const entry = loadMeta()[domain];
    return entry && entry.lastPrompt ? String(entry.lastPrompt) : '';
  }

  function setLastPrompt(domain, prompt) {
    const all = loadMeta();
    all[domain] = {
      ...(all[domain] || {}),
      lastPrompt: String(prompt || ''),
      lastPromptAt: Date.now(),
    };
    writeJson(metaPath, all);
    return all[domain];
  }

  function loadPositions() {
    const data = readJson(positionsPath, {});
    return data && typeof data === 'object' ? data : {};
  }

  function getPositions(domain) {
    const all = loadPositions();
    return all[domain] && typeof all[domain] === 'object' ? all[domain] : {};
  }

  function savePosition(domain, noteId, x, y) {
    const all = loadPositions();
    if (!all[domain] || typeof all[domain] !== 'object') all[domain] = {};
    all[domain][String(noteId)] = { x: Number(x) || 0, y: Number(y) || 0 };
    writeJson(positionsPath, all);
    return all[domain][String(noteId)];
  }

  return {
    getLastPrompt,
    setLastPrompt,
    getPositions,
    savePosition,
  };
}

module.exports = { createPageNotesStore };
