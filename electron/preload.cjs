const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('canvas', {
  copyObjects: (objects) => ipcRenderer.invoke('canvas:copy-objects', objects),
  cancelCopy: () => ipcRenderer.send('canvas:cancel-copy'),
  copyText: (text) => ipcRenderer.invoke('canvas:copy-text', text),
  clipboardObjects: () => ipcRenderer.invoke('canvas:clipboard-objects'),
  fullscreenState: () => ipcRenderer.invoke('canvas:fullscreen-state'),
  toggleFullscreen: () => ipcRenderer.invoke('canvas:toggle-fullscreen'),
  onFullscreenChange: (callback) => {
    const handler = (_event, fullscreen) => callback(fullscreen);
    ipcRenderer.on('canvas:fullscreen-changed', handler);
    return () => ipcRenderer.removeListener('canvas:fullscreen-changed', handler);
  },
  invoke: (command, args) => ipcRenderer.invoke('canvas:invoke', command, args),
  pickMedia: () => ipcRenderer.invoke('canvas:pick-media'),
  importPortable: () => ipcRenderer.invoke('canvas:import-board'),
  exportPortable: (id) => ipcRenderer.invoke('canvas:export-board', id),
  exportImage: (args) => ipcRenderer.invoke('canvas:export-image', args),
  downloadAsset: (args) => ipcRenderer.invoke('canvas:download-asset', args),
  printDocument: (args) => ipcRenderer.invoke('canvas:print-document', args),
  convertOffice: (args) => ipcRenderer.invoke('canvas:convert-office', args),
  onOfficeProgress: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('canvas:office-progress', handler);
    return () => ipcRenderer.removeListener('canvas:office-progress', handler);
  },
  assetDimensions: (id) => ipcRenderer.invoke('canvas:asset-dimensions', id),
  recognizeAsset: (id) => ipcRenderer.invoke('canvas:recognize-asset', id),
  recognizeImage: (bytes) => ipcRenderer.invoke('canvas:recognize-image', bytes),
  openExport: (id, folder) => ipcRenderer.invoke('canvas:open-export', id, folder),
  copyExport: (id) => ipcRenderer.invoke('canvas:copy-export', id),
  openExternal: (url) => ipcRenderer.invoke('canvas:open-link', url),
  linkPreview: (url) => ipcRenderer.invoke('canvas:link-preview', url),
  mcpStatus: () => ipcRenderer.invoke('canvas:mcp-status'),
  mcpUpdate: (patch) => ipcRenderer.invoke('canvas:mcp-update', patch),
  onMcpSync: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('canvas:mcp-sync', handler);
    return () => ipcRenderer.removeListener('canvas:mcp-sync', handler);
  },
  mcpReady: (id, error) => ipcRenderer.send('canvas:mcp-ready', { id, error }),
  dataDirectory: () => ipcRenderer.invoke('canvas:data-directory'),
  appInfo: () => ipcRenderer.invoke('canvas:app-info'),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke('canvas:set-open-at-login', enabled),
  openFolder: (which) => ipcRenderer.invoke('canvas:open-folder', which),
  exportLibrary: () => ipcRenderer.invoke('canvas:export-library'),
  licenses: () => ipcRenderer.invoke('canvas:licenses'),
  setFullscreenKeys: (bindings) => ipcRenderer.send('canvas:fullscreen-keys', bindings),
  live: {
    status: () => ipcRenderer.invoke('canvas:live-status'),
    start: (options) => ipcRenderer.invoke('canvas:live-start', options),
    stop: () => ipcRenderer.invoke('canvas:live-stop'),
    configure: (options) => ipcRenderer.invoke('canvas:live-configure', options),
    answer: (id, allow, permission) =>
      ipcRenderer.invoke('canvas:live-answer', id, allow, permission),
    setGuestPermission: (id, permission) =>
      ipcRenderer.invoke('canvas:live-guest-permission', id, permission),
    removeGuest: (id) => ipcRenderer.invoke('canvas:live-remove-guest', id),
    onStatus: (callback) => {
      const handler = (_event, status) => callback(status);
      ipcRenderer.on('canvas:live-status', handler);
      return () => ipcRenderer.removeListener('canvas:live-status', handler);
    },
  },
  cloud: {
    status: () => ipcRenderer.invoke('canvas:cloud-status'),
    enable: (name) => ipcRenderer.invoke('canvas:cloud-enable', name),
    join: (code, name) => ipcRenderer.invoke('canvas:cloud-join', code, name),
    identify: (name) => ipcRenderer.invoke('canvas:cloud-identify', name),
    rename: (name) => ipcRenderer.invoke('canvas:cloud-rename', name),
    setLibrary: (on, name) => ipcRenderer.invoke('canvas:cloud-set-library', on, name),
    sharePeople: (kind, id) => ipcRenderer.invoke('canvas:cloud-share-people', kind, id),
    invite: (kind, id, role, name) =>
      ipcRenderer.invoke('canvas:cloud-invite', kind, id, role, name),
    setPersonRole: (share, person, role) =>
      ipcRenderer.invoke('canvas:cloud-set-person-role', share, person, role),
    removePerson: (share, person) =>
      ipcRenderer.invoke('canvas:cloud-remove-person', share, person),
    setBoardAccess: (boardId, person, role) =>
      ipcRenderer.invoke('canvas:cloud-set-board-access', boardId, person, role),
    stopSharing: (share) => ipcRenderer.invoke('canvas:cloud-stop-sharing', share),
    leave: (share) => ipcRenderer.invoke('canvas:cloud-leave', share),
    profile: () => ipcRenderer.invoke('canvas:cloud-profile'),
    setAvatar: (asset) => ipcRenderer.invoke('canvas:cloud-set-avatar', asset),
    setSong: (asset, name) => ipcRenderer.invoke('canvas:cloud-set-song', asset, name),
    setPublishSong: (on) => ipcRenderer.invoke('canvas:cloud-set-publish-song', on),
    profileMedia: (person, avatar, song) =>
      ipcRenderer.invoke('canvas:cloud-profile-media', person, avatar, song),
    joinBoard: (boardId) => ipcRenderer.invoke('canvas:cloud-join-board', boardId),
    leaveBoard: () => ipcRenderer.invoke('canvas:cloud-leave-board'),
    sendCursor: (data) => ipcRenderer.send('canvas:cloud-cursor', data),
    onPresence: (callback) => {
      const handler = (_event, message) => callback(message);
      ipcRenderer.on('canvas:presence', handler);
      return () => ipcRenderer.removeListener('canvas:presence', handler);
    },
    disable: () => ipcRenderer.invoke('canvas:cloud-disable'),
    pairingCode: () => ipcRenderer.invoke('canvas:cloud-pairing-code'),
    devices: () => ipcRenderer.invoke('canvas:cloud-devices'),
    removeDevice: (id) => ipcRenderer.invoke('canvas:cloud-remove-device', id),
    syncNow: () => ipcRenderer.invoke('canvas:cloud-sync-now'),
    onStatus: (callback) => {
      const handler = (_event, status) => callback(status);
      ipcRenderer.on('canvas:cloud-status', handler);
      return () => ipcRenderer.removeListener('canvas:cloud-status', handler);
    },
  },
  onClose: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('canvas:close-request', handler);
    return () => ipcRenderer.removeListener('canvas:close-request', handler);
  },
  closeReady: () => ipcRenderer.send('canvas:close-ready'),
  rendererReady: () => ipcRenderer.send('canvas:renderer-ready'),
});
