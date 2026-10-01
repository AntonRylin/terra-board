const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('canvas', {
  invoke: (command, args) => ipcRenderer.invoke('canvas:invoke', command, args),
  pickMedia: () => ipcRenderer.invoke('canvas:pick-media'),
  importPortable: () => ipcRenderer.invoke('canvas:import-board'),
  exportPortable: (id) => ipcRenderer.invoke('canvas:export-board', id),
  openExternal: (url) => ipcRenderer.invoke('canvas:open-link', url),
  dataDirectory: () => ipcRenderer.invoke('canvas:data-directory'),
  onClose: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('canvas:close-request', handler);
    return () => ipcRenderer.removeListener('canvas:close-request', handler);
  },
  closeReady: () => ipcRenderer.send('canvas:close-ready'),
  rendererReady: () => ipcRenderer.send('canvas:renderer-ready'),
});
