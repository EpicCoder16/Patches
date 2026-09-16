'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('patchesPage', {
  saveNotePosition: (payload) => ipcRenderer.send('note-position', payload),
});
