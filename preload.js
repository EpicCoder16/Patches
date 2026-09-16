const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('authAPI', {
  getFirebaseConfig: () => ipcRenderer.invoke('get-firebase-config'),
  notifyAuthSuccess: (payload) => ipcRenderer.invoke('auth-established', payload),
  notifySignOut: () => ipcRenderer.invoke('auth-signed-out'),
  onPatchesSyncRequest: (cb) => {
    ipcRenderer.on('sync-patches-to-cloud', (_, data) => cb(data));
  },
  onAuthRequired: (cb) => {
    ipcRenderer.on('auth-required', () => cb());
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', { url }),
});

contextBridge.exposeInMainWorld('patches', {
  navigate:           (url)  => ipcRenderer.invoke('navigate', url),
  goBack:             ()     => ipcRenderer.invoke('go-back'),
  goForward:          ()     => ipcRenderer.invoke('go-forward'),
  reload:             ()     => ipcRenderer.invoke('reload'),
  getCurrentURL:      ()     => ipcRenderer.invoke('get-current-url'),
  getApiKeyStatus:    ()     => ipcRenderer.invoke('get-api-key-status'),
  applyPageNotes:     (opts) => ipcRenderer.invoke('apply-page-notes', opts),
  getPageNotesState:  ()     => ipcRenderer.invoke('get-page-notes-state'),
  refreshPageNotes:   ()     => ipcRenderer.invoke('refresh-page-notes'),
  getModel:           ()     => ipcRenderer.invoke('get-model'),
  getSupportedModels: ()     => ipcRenderer.invoke('get-supported-models'),
  setModel:           (model) => ipcRenderer.invoke('set-model', { model }),
  setOverlayOpen:       (opts) => ipcRenderer.invoke('set-overlay-open', opts),
  setPatchesPanelOpen:  (opts) => ipcRenderer.invoke('set-patches-panel-open', opts),
  applyPatch:         (opts) => ipcRenderer.invoke('apply-patch', opts),
  getPatches:         ()     => ipcRenderer.invoke('get-patches'),
  deletePatch:        (opts) => ipcRenderer.invoke('delete-patch', opts),
  resetDomainPatches: ()     => ipcRenderer.invoke('reset-domain-patches'),
  setPatchAspectEnabled: (opts) => ipcRenderer.invoke('set-patch-aspect-enabled', opts),
  togglePatches:      (opts) => ipcRenderer.invoke('toggle-patches', opts),
  openSettings:       ()     => ipcRenderer.invoke('open-settings'),
  signOut:            ()     => ipcRenderer.invoke('auth-signed-out'),
  getAuthUser:        ()     => ipcRenderer.invoke('get-auth-user'),
  onAuthReady:        (cb)   => ipcRenderer.on('auth-ready', () => cb()),

  onURLChanged:         (cb) => ipcRenderer.on('url-changed',         (_, v) => cb(v)),
  onTitleChanged:       (cb) => ipcRenderer.on('title-changed',        (_, v) => cb(v)),
  onPageNotesStatus:    (cb) => ipcRenderer.on('page-notes-status',    (_, v) => cb(v)),
  onToggleCommandBar:   (cb) => ipcRenderer.on('toggle-command-bar',   ()     => cb()),
  onToggleNotesBar:     (cb) => ipcRenderer.on('toggle-notes-bar',     ()     => cb()),
  onTogglePatchesPanel: (cb) => ipcRenderer.on('toggle-patches-panel', ()     => cb()),
  onModelUsed:          (cb) => ipcRenderer.on('model-used',           (_, v) => cb(v)),
});
