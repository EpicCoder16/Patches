const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('patches', {
  navigate:           (url)  => ipcRenderer.invoke('navigate', url),
  goBack:             ()     => ipcRenderer.invoke('go-back'),
  goForward:          ()     => ipcRenderer.invoke('go-forward'),
  reload:             ()     => ipcRenderer.invoke('reload'),
  getCurrentURL:      ()     => ipcRenderer.invoke('get-current-url'),
  getModel:           ()     => ipcRenderer.invoke('get-model'),
  setOverlayOpen:       (opts) => ipcRenderer.invoke('set-overlay-open', opts),
  setPatchesPanelOpen:  (opts) => ipcRenderer.invoke('set-patches-panel-open', opts),
  applyPatch:         (opts) => ipcRenderer.invoke('apply-patch', opts),
  getPatches:         ()     => ipcRenderer.invoke('get-patches'),
  deletePatch:        (opts) => ipcRenderer.invoke('delete-patch', opts),
  resetDomainPatches: ()     => ipcRenderer.invoke('reset-domain-patches'),
  setPatchAspectEnabled: (opts) => ipcRenderer.invoke('set-patch-aspect-enabled', opts),
  togglePatches:      (opts) => ipcRenderer.invoke('toggle-patches', opts),

  onURLChanged:         (cb) => ipcRenderer.on('url-changed',         (_, v) => cb(v)),
  onTitleChanged:       (cb) => ipcRenderer.on('title-changed',        (_, v) => cb(v)),
  onToggleCommandBar:   (cb) => ipcRenderer.on('toggle-command-bar',   ()     => cb()),
  onTogglePatchesPanel: (cb) => ipcRenderer.on('toggle-patches-panel', ()     => cb()),
  onModelUsed:          (cb) => ipcRenderer.on('model-used',           (_, v) => cb(v)),
});
