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
  openExport: (id, folder) => ipcRenderer.invoke('canvas:open-export', id, folder),
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
  onClose: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('canvas:close-request', handler);
    return () => ipcRenderer.removeListener('canvas:close-request', handler);
  },
  closeReady: () => ipcRenderer.send('canvas:close-ready'),
  rendererReady: () => ipcRenderer.send('canvas:renderer-ready'),
});
