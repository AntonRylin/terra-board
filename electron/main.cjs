const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  dialog,
  shell,
  Menu,
  clipboard,
  ClipboardItem,
} = require('electron');
const { createImageClipboard } = require('./image-clipboard.cjs');
const { createVisualExport } = require('./visual-export.cjs');
const { attachWindowShadow } = require('./window-shadow.cjs');
const { fetchPreview } = require('./link-preview.cjs');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Readable } = require('node:stream');
const { createHash, randomUUID } = require('node:crypto');
const { libraryRoot } = require('./storage-paths.cjs');
protocol.registerSchemesAsPrivileged([
  { scheme: 'canvas-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  {
    scheme: 'canvas-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
const { McpService } = require('./mcp-server.cjs');
let mcp,
  externalPhase = null;
const externalWaiters = new Map();
let externalId = 0;
function syncRenderer(phase, detail = {}) {
  if (!win || win.isDestroyed() || closed) return Promise.reject(Error('Terra Board is closing.'));
  return new Promise((resolve, reject) => {
    const id = ++externalId;
    const timer = setTimeout(() => {
      externalWaiters.delete(id);
      reject(Error('Board is busy. Retry when saving completes.'));
    }, 30000);
    externalWaiters.set(id, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    win.webContents.send('canvas:mcp-sync', { id, phase, ...detail });
  });
}
async function mcpTransaction(job, detail) {
  await rendererReady;
  externalPhase = 'prepare';
  try {
    await syncRenderer('prepare');
    externalPhase = 'apply';
    return await job();
  } finally {
    externalPhase = 'refresh';
    try {
      await syncRenderer('finish', { change: detail.change, idBoard: detail.id });
    } finally {
      externalPhase = null;
    }
  }
}
const smoke = process.argv.includes('--smoke-test');
const launchStarted = performance.now();
const root = libraryRoot({
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  exePath: app.getPath('exe'),
  dataDir: process.env.CANVAS_DATA_DIR,
});
for (const [name, directory] of Object.entries({
  userData: 'settings',
  sessionData: 'settings',
  crashDumps: 'crashes',
  temp: 'temp',
})) {
  const location = path.join(root, directory);
  fs.mkdirSync(location, { recursive: true });
  app.setPath(name, location);
}
app.setAppLogsPath(path.join(root, 'logs'));
let win,
  worker,
  closed = false,
  quitting = false,
  counter = 0,
  workerFailed = false;
let readyResolve;
const rendererReady = new Promise((resolve) => (readyResolve = resolve));
const pending = new Map();
function startWorker() {
  workerFailed = false;
  worker = new Worker(path.join(__dirname, 'worker.cjs'), { workerData: { root } });
  const instance = worker;
  worker.on('message', (m) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(Error(m.error)) : p.resolve(m.result);
  });
  const fail = (e) => {
    if (worker !== instance) return;
    workerFailed = true;
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => {
    if (!quitting) fail(Error('Local storage stopped unexpectedly. Retry saving to restart it.'));
  });
}
function call(command, args = {}) {
  if (workerFailed && !quitting) startWorker();
  return new Promise((resolve, reject) => {
    const id = ++counter;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, command, args });
  });
}
const commands = new Set([
  'library',
  'createBoard',
  'createFolder',
  'updateBoard',
  'updateFolder',
  'removeFolder',
  'restoreBoard',
  'duplicateBoard',
  'loadBoard',
  'patchBoard',
  'setLastBoard',
  'importAsset',
]);
const dev = process.env.CANVAS_DEV_URL;
function trusted(event) {
  const url = event.senderFrame?.url;
  if (
    event.sender !== win?.webContents ||
    !(url?.startsWith('canvas-app://app/') || (dev && url?.startsWith(dev + '/')))
  )
    throw Error('Untrusted sender');
}
async function seed() {
  const l = await call('library');
  if (l.boards.length) return;
  const f = await call('createFolder', { name: 'Projects' });
  await call('createBoard', { name: 'References', folderId: f.id });
  const b = await call('createBoard', { name: 'Ideas' });
  await call('patchBoard', {
    id: b.id,
    revision: 0,
    upserts: [
      {
        id: 'welcome-title',
        type: 'text',
        x: 80,
        y: 65,
        width: 650,
        height: 70,
        z: 1,
        text: 'The next good idea.',
        fontSize: 36,
        color: '#242b35',
      },
      {
        id: 'welcome-subtitle',
        type: 'text',
        x: 82,
        y: 136,
        width: 500,
        height: 40,
        z: 2,
        text: 'A space for everything you want to keep.',
        fontSize: 17,
        color: '#78818e',
      },
      {
        id: 'welcome-note',
        type: 'note',
        x: 82,
        y: 220,
        width: 255,
        height: 230,
        z: 3,
        text: 'Keep it simple.\n\nPaste an image.\nDrop a reference.\nMake room for ideas.',
        color: '#f8efd4',
        fontSize: 21,
      },
      {
        id: 'welcome-frame',
        type: 'frame',
        x: 390,
        y: 220,
        width: 430,
        height: 280,
        z: 0,
        text: 'Your first collection',
        color: '#edf1f6',
      },
      {
        id: 'welcome-help',
        type: 'text',
        x: 424,
        y: 290,
        width: 350,
        height: 135,
        z: 4,
        text: 'Ctrl + V to paste\nRight-drag to explore\nScroll to zoom toward the cursor',
        fontSize: 18,
        color: '#78818e',
      },
    ],
    deleted: [],
    camera: { x: 0, y: 0, zoom: 1 },
  });
  await call('setLastBoard', { id: b.id });
}
app
  .whenReady()
  .then(async () => {
    if (!app.requestSingleInstanceLock() && !smoke) {
      app.quit();
      return;
    }
    startWorker();
    protocol.handle('canvas-app', (request) => {
      const url = new URL(request.url);
      let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const base = path.join(__dirname, '../dist'),
        file = path.resolve(base, relative);
      if (url.host !== 'app' || !(file === base || file.startsWith(base + path.sep)))
        return new Response('Not found', { status: 404 });
      try {
        const mime =
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.svg': 'image/svg+xml',
          }[path.extname(file)] || 'application/octet-stream';
        return new Response(fs.readFileSync(file), { headers: { 'Content-Type': mime } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    protocol.handle('canvas-media', async (request) => {
      try {
        const u = new URL(request.url),
          [, id, variant] = u.pathname.split('/');
        if (u.hostname !== 'asset') throw Error('Invalid media');
        const a = await call('asset', { id, variant: variant || 'preview' }),
          size = fs.statSync(a.file).size;
        let start = 0,
          end = size - 1,
          status = 200;
        const headers = {
          'Content-Type': a.contentType,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=31536000, immutable',
        };
        const range = request.headers.get('range');
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (!match) return new Response(null, { status: 416 });
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), end) : end;
          if (start > end || start >= size)
            return new Response(null, {
              status: 416,
              headers: { 'Content-Range': `bytes */${size}` },
            });
          status = 206;
          headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        }
        headers['Content-Length'] = String(end - start + 1);
        return new Response(Readable.toWeb(fs.createReadStream(a.file, { start, end })), {
          status,
          headers,
        });
      } catch {
        return new Response('Media not found', { status: 404 });
      }
    });
    win = new BrowserWindow({
      width: 1380,
      height: 900,
      minWidth: 760,
      minHeight: 560,
      show: false,
      title: 'Terra Board',
      icon: path.join(__dirname, '../assets/icon.png'),
      backgroundColor: '#fbfcfd',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    Menu.setApplicationMenu(null);
    const boardClipboard = createImageClipboard({
      clipboard,
      ClipboardItem,
      loadAsset: (id) => call('asset', { id, variant: 'original' }),
      saveImage: async (png) => {
        const directory = path.join(root, 'temp', 'clipboard');
        await fs.promises.mkdir(directory, { recursive: true });
        const file = path.join(
          directory,
          `Image-${createHash('sha256').update(png).digest('hex')}.png`,
        );
        // Immutable, reusable files remain valid after switching boards or closing Terra.
        const temporary = file + '.' + randomUUID() + '.tmp';
        try {
          await fs.promises.writeFile(temporary, png, { flag: 'wx' });
          await fs.promises.rename(temporary, file);
        } finally {
          await fs.promises.unlink(temporary).catch(() => {});
        }
        return pathToFileURL(file).href;
      },
    });
    ipcMain.handle('canvas:copy-objects', (event, objects) => {
      trusted(event);
      return boardClipboard.copy(objects);
    });
    ipcMain.handle('canvas:clipboard-objects', (event) => {
      trusted(event);
      return boardClipboard.readObjects();
    });
    ipcMain.on('canvas:cancel-copy', (event) => {
      trusted(event);
      boardClipboard.cancel();
    });
    win.on('enter-full-screen', () => win.webContents.send('canvas:fullscreen-changed', true));
    win.on('leave-full-screen', () => win.webContents.send('canvas:fullscreen-changed', false));
    let fullscreenEscapeHeld = false;
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'Escape' && input.type === 'keyUp') fullscreenEscapeHeld = false;
      if (input.key === 'Escape' && input.type === 'keyDown' && fullscreenEscapeHeld) {
        event.preventDefault();
        return;
      }
      if (input.type !== 'keyDown' || input.control || input.alt || input.meta || input.shift)
        return;
      if (input.key === 'F11') {
        event.preventDefault();
        if (!input.isAutoRepeat) win.setFullScreen(!win.isFullScreen());
      } else if (input.key === 'Escape' && win.isFullScreen()) {
        // Consume this Escape so leaving fullscreen does not also cancel an edit.
        event.preventDefault();
        fullscreenEscapeHeld = true;
        win.setFullScreen(false);
      }
    });
    win.on('blur', () => {
      fullscreenEscapeHeld = false;
    });
    ipcMain.handle('canvas:fullscreen-state', (event) => {
      trusted(event);
      return win.isFullScreen();
    });
    ipcMain.handle('canvas:toggle-fullscreen', (event) => {
      trusted(event);
      win.setFullScreen(!win.isFullScreen());
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    win.webContents.session.webRequest.onBeforeRequest((details, cb) => {
      const host = new URL(details.url).hostname;
      const playerHost = [
        'youtube-nocookie.com',
        'youtube.com',
        'ytimg.com',
        'googlevideo.com',
        'gstatic.com',
        'google.com',
        'doubleclick.net',
      ].some((domain) => host === domain || host.endsWith('.' + domain));
      const allowed =
        ['canvas-app:', 'canvas-media:', 'data:', 'blob:', 'devtools:'].some((s) =>
          details.url.startsWith(s),
        ) ||
        (details.url.startsWith('https:') && playerHost && details.resourceType !== 'mainFrame') ||
        (dev &&
          (details.url.startsWith(dev + '/') || details.url.startsWith('ws://127.0.0.1:5173/')));
      cb({ cancel: !allowed });
    });
    win.webContents.session.webRequest.onBeforeSendHeaders(
      { urls: ['https://www.youtube-nocookie.com/embed/*'] },
      (details, cb) => {
        cb({
          requestHeaders: { ...details.requestHeaders, Referer: 'https://terra.board.desktop/' },
        });
      },
    );
    let previewActive = 0;
    const previewWaiters = [];
    ipcMain.handle('canvas:link-preview', async (e, url) => {
      trusted(e);
      if (previewWaiters.length >= 64) return null;
      if (previewActive >= 4) await new Promise((resolve) => previewWaiters.push(resolve));
      previewActive++;
      try {
        const meta = await fetchPreview(url);
        let assetId, linkIconId;
        if (meta.imageBytes) {
          try {
            assetId = (
              await call('importAsset', { name: 'Link preview.jpg', bytes: meta.imageBytes })
            ).id;
          } catch {}
        }
        if (meta.iconBytes) {
          try {
            linkIconId = (
              await call('importAsset', { name: 'Site icon.png', bytes: meta.iconBytes })
            ).id;
          } catch {
            try {
              const image = require('electron').nativeImage.createFromBuffer(meta.iconBytes);
              if (!image.isEmpty())
                linkIconId = (
                  await call('importAsset', { name: 'Site icon.png', bytes: image.toPNG() })
                ).id;
            } catch {}
          }
        }
        return {
          text: meta.title,
          linkDescription: meta.description,
          ...(assetId ? { assetId } : {}),
          ...(linkIconId ? { linkIconId } : {}),
        };
      } catch {
        return null;
      } finally {
        previewActive--;
        previewWaiters.shift()?.();
      }
    });
    mcp = new McpService({ root, call, transaction: mcpTransaction });
    ipcMain.handle('canvas:mcp-status', (e) => {
      trusted(e);
      return mcp.status();
    });
    ipcMain.handle('canvas:mcp-update', (e, patch) => {
      trusted(e);
      return mcp.update(patch);
    });
    ipcMain.on('canvas:mcp-ready', (e, { id, error }) => {
      trusted(e);
      const waiting = externalWaiters.get(id);
      if (!waiting) return;
      externalWaiters.delete(id);
      error ? waiting.reject(Error(error)) : waiting.resolve();
    });
    ipcMain.handle('canvas:invoke', (e, command, args) => {
      trusted(e);
      if (!commands.has(command)) throw Error('Unknown command');
      if (externalPhase === 'apply' && !['library', 'loadBoard'].includes(command))
        throw Error('AI edit in progress. Retry after it completes.');
      return call(command, args);
    });
    ipcMain.handle('canvas:pick-media', async (e) => {
      trusted(e);
      const r = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: 'Images and videos',
            extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'tiff', 'mp4', 'webm'],
          },
        ],
      });
      if (r.canceled) return [];
      const result = [];
      for (const file of r.filePaths) result.push(await call('importFile', { file }));
      return result;
    });
    ipcMain.handle('canvas:import-board', async (e) => {
      trusted(e);
      const r = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'Terra Board board', extensions: ['canvas'] }],
      });
      return r.canceled ? null : call('importFile', { file: r.filePaths[0] });
    });
    ipcMain.handle('canvas:export-board', async (e, id) => {
      trusted(e);
      const r = await dialog.showSaveDialog(win, {
        defaultPath: 'Board.canvas',
        filters: [{ name: 'Editable board with all media', extensions: ['canvas'] }],
      });
      return r.canceled ? false : call('exportFile', { id, file: r.filePath });
    });
    const visualExport = createVisualExport({ dialog, shell, getWindow: () => win });
    ipcMain.handle('canvas:asset-dimensions', async (e, id) => {
      trusted(e);
      const { width, height } = await call('asset', { id, variant: 'original' });
      return { width, height };
    });
    ipcMain.handle('canvas:export-image', (e, args) => {
      trusted(e);
      return visualExport.save(args);
    });
    ipcMain.handle('canvas:open-export', (e, id, folder) => {
      trusted(e);
      return visualExport.open(id, folder === true);
    });
    ipcMain.handle('canvas:open-link', (e, url) => {
      trusted(e);
      const u = new URL(url);
      if (!['https:', 'http:'].includes(u.protocol)) throw Error('Only web links can be opened');
      return shell.openExternal(u.href);
    });
    ipcMain.handle('canvas:data-directory', (e) => {
      trusted(e);
      return root;
    });
    ipcMain.on('canvas:renderer-ready', (e) => {
      trusted(e);
      readyResolve();
    });
    ipcMain.on('canvas:close-ready', (e) => {
      trusted(e);
      closed = true;
      win.close();
    });
    win.on('close', (event) => {
      if (!closed && !smoke) {
        event.preventDefault();
        win.webContents.send('canvas:close-request');
      }
    });
    app.on('second-instance', () => {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    await seed();
    if (dev) await win.loadURL(dev);
    else await win.loadURL('canvas-app://app/index.html');
    await mcp.start();
    if (smoke) {
      await Promise.race([
        rendererReady,
        new Promise((_, reject) =>
          setTimeout(() => reject(Error('Renderer did not become ready')), 12000),
        ),
      ]);
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(':memory:');
      console.log(
        'DESKTOP_SMOKE',
        JSON.stringify({
          library: (await call('library')).boards.length,
          sqlite: db.prepare('select sqlite_version() as v').get().v,
          node: process.versions.node,
          electron: process.versions.electron,
          firstCanvasMs: Math.round(performance.now() - launchStarted),
          dataDirectory: root,
          userData: app.getPath('userData'),
          sessionData: app.getPath('sessionData'),
          logs: app.getPath('logs'),
          crashDumps: app.getPath('crashDumps'),
          temp: app.getPath('temp'),
        }),
      );
      db.close();
      setTimeout(() => {
        closed = true;
        app.quit();
      }, 1800);
    } else {
      attachWindowShadow(win, { BrowserWindow });
      win.show();
    }
  })
  .catch((e) => {
    console.error(e);
    if (!smoke) dialog.showErrorBox('Terra Board could not open', e.message);
    app.exit(1);
  });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (!worker || quitting) return;
  if (win && !win.isDestroyed() && !closed && !smoke) {
    event.preventDefault();
    win.close();
    return;
  }
  event.preventDefault();
  quitting = true;
  void mcp?.stop();
  if (workerFailed) {
    worker.terminate();
    app.quit();
    return;
  }
  call('close').finally(() => {
    worker.terminate();
    app.quit();
  });
});
