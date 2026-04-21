const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  saveKey: (key) => ipcRenderer.invoke('save-api-key', { key }),
  openLink: (url) => ipcRenderer.invoke('open-external', { url }),
  getApiKeyStatus: () => ipcRenderer.invoke('get-api-key-status'),
});
