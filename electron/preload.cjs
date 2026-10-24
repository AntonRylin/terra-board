const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('canvas', {
  copyObjects: (objects) => ipcRenderer.invoke('canvas:copy-objects', objects),
  cancelCopy: () => ipcRenderer.send('canvas:cancel-copy'),
  copyText: (text) => ipcRenderer.invoke('canvas:copy-text', text),
  songFromLink: (url) => ipcRenderer.invoke('canvas:song-from-link', url),
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
  importAlbumFiles: (args) => ipcRenderer.invoke('canvas:import-album-files', args),
  locateAsset: (args) => ipcRenderer.invoke('canvas:locate-asset', args),
  // Where a dropped file is on disk ('' for pasted or generated files).
  filePath: (file) => webUtils.getPathForFile(file),
  importPortable: () => ipcRenderer.invoke('canvas:import-board'),
  // Folder frames and file tiles (electron/local-files.cjs).
  files: {
    list: (args) => ipcRenderer.invoke('canvas:files-list', args),
    icons: (requests) => ipcRenderer.invoke('canvas:files-icons', requests),
    transfer: (args) => ipcRenderer.invoke('canvas:files-transfer', args),
    rename: (args) => ipcRenderer.invoke('canvas:files-rename', args),
    newFolder: (args) => ipcRenderer.invoke('canvas:files-new-folder', args),
    trash: (args) => ipcRenderer.invoke('canvas:files-trash', args),
    revert: (args) => ipcRenderer.invoke('canvas:files-revert', args),
    saveAssets: (args) => ipcRenderer.invoke('canvas:files-save-assets', args),
    classify: (args) => ipcRenderer.invoke('canvas:files-classify', args),
    import: (args) => ipcRenderer.invoke('canvas:files-import', args),
    open: (args) => ipcRenderer.invoke('canvas:files-open', args),
    openWith: (args) => ipcRenderer.invoke('canvas:files-open-with', args),
    reveal: (args) => ipcRenderer.invoke('canvas:files-reveal', args),
    copy: (args) => ipcRenderer.invoke('canvas:files-clipboard-copy', args),
    readClipboard: () => ipcRenderer.invoke('canvas:files-clipboard-read'),
    clearClipboard: () => ipcRenderer.invoke('canvas:files-clipboard-clear'),
    choose: (args) => ipcRenderer.invoke('canvas:files-choose', args),
    desktops: () => ipcRenderer.invoke('canvas:files-desktops'),
    focusWindow: (args) => ipcRenderer.invoke('canvas:files-focus-window', args),
    switchDesktop: (args) => ipcRenderer.invoke('canvas:files-switch-desktop', args),
    closeWindow: (args) => ipcRenderer.invoke('canvas:files-close-window', args),
    parkWindow: (args) => ipcRenderer.invoke('canvas:files-park-window', args),
    dockWindow: (args) => ipcRenderer.invoke('canvas:files-dock-window', args),
    releaseWindow: (args) => ipcRenderer.invoke('canvas:files-release-window', args),
    appInput: (args) => ipcRenderer.send('canvas:files-app-input', args),
    appPopup: (args) => ipcRenderer.invoke('canvas:files-app-popup', args),
    appPicture: (args) => ipcRenderer.send('canvas:files-app-picture', args),
    appPictures: () => ipcRenderer.invoke('canvas:files-app-pictures'),
    nightLight: () => ipcRenderer.invoke('canvas:files-night-light'),
    setNightLight: (args) => ipcRenderer.invoke('canvas:files-set-night-light', args),
    onRepark: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('canvas:files-repark', handler);
      return () => ipcRenderer.removeListener('canvas:files-repark', handler);
    },
    source: (args) => ipcRenderer.invoke('canvas:files-source', args),
    watch: (args) => ipcRenderer.invoke('canvas:files-watch', args),
    unwatch: (args) => ipcRenderer.invoke('canvas:files-unwatch', args),
    reset: () => ipcRenderer.invoke('canvas:files-reset'),
    drag: (paths, icon) => ipcRenderer.send('canvas:files-drag', { paths, icon }),
    onChange: (callback) => {
      const handler = (_event, dir) => callback(dir);
      ipcRenderer.on('canvas:files-changed', handler);
      return () => ipcRenderer.removeListener('canvas:files-changed', handler);
    },
  },
  // Telegram frames (electron/telegram.cjs).
  telegram: {
    status: () => ipcRenderer.invoke('canvas:telegram-status'),
    snapshot: () => ipcRenderer.invoke('canvas:telegram-snapshot'),
    start: () => ipcRenderer.invoke('canvas:telegram-start'),
    invoke: (query) => ipcRenderer.invoke('canvas:telegram-invoke', query),
    stage: (sources) => ipcRenderer.invoke('canvas:telegram-stage', sources),
    voice: (bytes) => ipcRenderer.invoke('canvas:telegram-voice', bytes),
    pick: () => ipcRenderer.invoke('canvas:telegram-pick'),
    download: (id) => ipcRenderer.invoke('canvas:telegram-download', id),
    setCredentials: (input) => ipcRenderer.invoke('canvas:telegram-credentials', input),
    logOut: () => ipcRenderer.invoke('canvas:telegram-log-out'),
    forget: () => ipcRenderer.invoke('canvas:telegram-forget'),
    drag: (path, icon) => ipcRenderer.send('canvas:telegram-drag', { path, icon }),
    onUpdate: (callback) => {
      const handler = (_event, batch) => callback(batch);
      ipcRenderer.on('canvas:telegram-update', handler);
      return () => ipcRenderer.removeListener('canvas:telegram-update', handler);
    },
  },
  miro: {
    status: () => ipcRenderer.invoke('canvas:miro-status'),
    connect: (token, remember) => ipcRenderer.invoke('canvas:miro-connect', { token, remember }),
    boards: () => ipcRenderer.invoke('canvas:miro-boards'),
    add: (link) => ipcRenderer.invoke('canvas:miro-add', link),
    forget: () => ipcRenderer.invoke('canvas:miro-forget'),
    import: (ids) => ipcRenderer.invoke('canvas:miro-import', { ids }),
    onProgress: (callback) => {
      const handler = (_event, progress) => callback(progress);
      ipcRenderer.on('canvas:miro-progress', handler);
      return () => ipcRenderer.removeListener('canvas:miro-progress', handler);
    },
  },
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
  // Text recognition: the Windows OCR engine, or Tesseract on Linux when it is
  // installed (main passes --terra-text-recognition). Elsewhere these are absent,
  // so the board disables Copy text for images and reads PDFs by their own text.
  ...((process.platform === 'win32' || process.argv.includes('--terra-text-recognition')) && {
    recognizeAsset: (id) => ipcRenderer.invoke('canvas:recognize-asset', id),
    recognizeImage: (bytes) => ipcRenderer.invoke('canvas:recognize-image', bytes),
  }),
  platform: process.platform,
  openExport: (id, folder) => ipcRenderer.invoke('canvas:open-export', id, folder),
  copyExport: (id) => ipcRenderer.invoke('canvas:copy-export', id),
  openExternal: (url) => ipcRenderer.invoke('canvas:open-link', url),
  linkPreview: (url) => ipcRenderer.invoke('canvas:link-preview', url),
  htmlPage: (html) => ipcRenderer.invoke('canvas:html-page', html),
  htmlSnapshot: (args) => ipcRenderer.invoke('canvas:html-snapshot', args),
  browserSnapshot: (args) => ipcRenderer.invoke('canvas:browser-snapshot', args),
  browserCapture: (id) => ipcRenderer.invoke('canvas:browser-capture', id),
  browserDrop: (args) => ipcRenderer.invoke('canvas:browser-drop', args),
  onBrowserDownload: (callback) => {
    const handler = (_event, file) => callback(file);
    ipcRenderer.on('canvas:browser-downloaded', handler);
    return () => ipcRenderer.removeListener('canvas:browser-downloaded', handler);
  },
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
  extensions: {
    list: () => ipcRenderer.invoke('canvas:extensions-list'),
    install: (id) => ipcRenderer.invoke('canvas:extensions-install', id),
    cancel: (id) => ipcRenderer.invoke('canvas:extensions-cancel', id),
    remove: (id) => ipcRenderer.invoke('canvas:extensions-remove', id),
    onChange: (callback) => {
      const handler = (_event, list) => callback(list);
      ipcRenderer.on('canvas:extensions-changed', handler);
      return () => ipcRenderer.removeListener('canvas:extensions-changed', handler);
    },
  },
  updates: {
    status: () => ipcRenderer.invoke('canvas:update-status'),
    check: () => ipcRenderer.invoke('canvas:update-check'),
    setAutomatic: (on) => ipcRenderer.invoke('canvas:update-automatic', on),
    install: () => ipcRenderer.invoke('canvas:update-install'),
    onStatus: (callback) => {
      const handler = (_event, status) => callback(status);
      ipcRenderer.on('canvas:update-status', handler);
      return () => ipcRenderer.removeListener('canvas:update-status', handler);
    },
  },
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
    removeFromCloud: (boardId) => ipcRenderer.invoke('canvas:cloud-remove-from-cloud', boardId),
    upload: (kind, id, name) => ipcRenderer.invoke('canvas:cloud-upload', kind, id, name),
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
    sendEdit: (data) => ipcRenderer.send('canvas:cloud-edit', data),
    onPresence: (callback) => {
      const handler = (_event, message) => callback(message);
      ipcRenderer.on('canvas:presence', handler);
      return () => ipcRenderer.removeListener('canvas:presence', handler);
    },
    disable: () => ipcRenderer.invoke('canvas:cloud-disable'),
    devices: () => ipcRenderer.invoke('canvas:cloud-devices'),
    removeDevice: (id) => ipcRenderer.invoke('canvas:cloud-remove-device', id),
    syncNow: () => ipcRenderer.invoke('canvas:cloud-sync-now'),
    sendCode: (email) => ipcRenderer.invoke('canvas:cloud-send-code', email),
    verifyCode: (email, code) => ipcRenderer.invoke('canvas:cloud-verify-code', email, code),
    signInWith: (provider, email) =>
      ipcRenderer.invoke('canvas:cloud-sign-in-with', provider, email),
    cancelSignIn: () => ipcRenderer.invoke('canvas:cloud-cancel-sign-in'),
    signOut: () => ipcRenderer.invoke('canvas:cloud-sign-out'),
    deleteCloudData: () => ipcRenderer.invoke('canvas:cloud-delete-cloud-data'),
    signInMethods: () => ipcRenderer.invoke('canvas:cloud-sign-in-methods'),
    companyStatus: () => ipcRenderer.invoke('canvas:cloud-company-status'),
    company: (action, ...args) => ipcRenderer.invoke('canvas:cloud-company', action, ...args),
    companyExportAudit: () => ipcRenderer.invoke('canvas:cloud-company-export-audit'),
    serverTest: (input) => ipcRenderer.invoke('canvas:cloud-server-test', input),
    serverSet: (input, options) => ipcRenderer.invoke('canvas:cloud-server-set', input, options),
    onDeepLink: (callback) => {
      const handler = (_event, link) => callback(link);
      ipcRenderer.on('canvas:deep-link', handler);
      return () => ipcRenderer.removeListener('canvas:deep-link', handler);
    },
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
