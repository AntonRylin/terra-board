const {
  app,
  BrowserWindow,
  session,
  ipcMain,
  protocol,
  net,
  dialog,
  shell,
  Menu,
  clipboard,
  ClipboardItem,
  nativeImage,
  safeStorage,
} = require('electron');
const { CloudSync, cloudConfig } = require('./cloud-sync.cjs');
const { LiveShare } = require('./live-share.cjs');
const { createImageClipboard } = require('./image-clipboard.cjs');
const { createVisualExport } = require('./visual-export.cjs');
const { createAssetDownload, assetResponse } = require('./document-assets.cjs');
const { createDocumentPrint } = require('./document-print.cjs');
const { createOfficeConverter } = require('./office-converter.cjs');
const { attachWindowShadow } = require('./window-shadow.cjs');
const { fetchPreview } = require('./link-preview.cjs');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
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

// The renderer owns shortcut preferences; it sends the full-screen bindings here
// because this handler sees keys before the page does.
let fullscreenKeys = [{ code: 'F11' }];
function cleanFullscreenKeys(value) {
  if (!Array.isArray(value)) return fullscreenKeys;
  return value
    .filter((b) => b && typeof b.code === 'string' && b.code.length > 0 && b.code.length <= 40)
    .slice(0, 2)
    .map((b) => ({
      code: b.code,
      ctrl: b.ctrl === true,
      shift: b.shift === true,
      alt: b.alt === true,
    }));
}
const matchesInput = (b, input) =>
  b.code === input.code &&
  !!b.ctrl === !!(input.control || input.meta) &&
  !!b.shift === !!input.shift &&
  !!b.alt === !!input.alt;

let licenseList = null;
// Production dependency tree with each package's declared license.
function bundledLicenses() {
  if (licenseList) return licenseList;
  const base = app.getAppPath();
  const readPackage = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  const found = new Map();
  const queue = Object.keys(readPackage(base)?.dependencies || {}).map((name) => ({
    name,
    from: base,
  }));
  while (queue.length) {
    const { name, from } = queue.shift();
    const dir = [path.join(from, 'node_modules', name), path.join(base, 'node_modules', name)].find(
      (candidate) => fs.existsSync(path.join(candidate, 'package.json')),
    );
    if (!dir || found.has(dir)) continue;
    const pkg = readPackage(dir);
    if (!pkg) continue;
    const license =
      typeof pkg.license === 'string'
        ? pkg.license
        : pkg.license?.type || (Array.isArray(pkg.licenses) && pkg.licenses[0]?.type) || 'Unknown';
    found.set(dir, { name: pkg.name || name, version: String(pkg.version || ''), license });
    for (const dependency of Object.keys(pkg.dependencies || {}))
      queue.push({ name: dependency, from: dir });
  }
  licenseList = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  return licenseList;
}
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
// Outside changes (AI edits, cloud sync) pause the board, apply, then refresh it.
let externalTail = Promise.resolve();
function externalTransaction(job, finishDetail, source) {
  const run = async () => {
    await rendererReady;
    externalPhase = 'prepare';
    let result;
    try {
      await syncRenderer('prepare', { source });
      externalPhase = 'apply';
      result = await job();
      return result;
    } finally {
      externalPhase = 'refresh';
      try {
        await syncRenderer('finish', { ...finishDetail(result), source });
      } finally {
        externalPhase = null;
      }
    }
  };
  const next = externalTail.then(run, run);
  externalTail = next.catch(() => {});
  return next;
}
const mcpTransaction = (job, detail) =>
  externalTransaction(job, () => ({ change: detail.change, idBoard: detail.id }), 'ai');
const cloudTransaction = (job) =>
  externalTransaction(
    job,
    (result) => ({
      change: result?.boards?.length ? 'content' : result?.library ? 'library' : 'none',
      boards: result?.boards || [],
    }),
    'cloud',
  );
let cloud = null;
let liveShare = null;
// Guests' edits are already saved; refresh the host's open board, batched.
let guestRefresh = null;
function refreshAfterGuestEdit(boardId) {
  if (guestRefresh) return;
  guestRefresh = setTimeout(() => {
    guestRefresh = null;
    void externalTransaction(
      async () => ({ boards: [boardId] }),
      (result) => ({ change: 'content', boards: result?.boards || [boardId] }),
      'guest',
    ).catch(() => {});
  }, 400);
}
// Writes that change synced content; cloud sync pushes shortly after them.
const syncedCommands = new Set([
  'createBoard',
  'createFolder',
  'updateBoard',
  'updateFolder',
  'removeFolder',
  'restoreBoard',
  'duplicateBoard',
  'patchBoard',
  'importBoard',
]);
const smoke = process.argv.includes('--smoke-test');
const launchStarted = performance.now();
const root = libraryRoot({
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  exePath: app.getPath('exe'),
  dataDir: process.env.CANVAS_DATA_DIR,
  distribution: require('../package.json').terraDistribution,
  localAppData: process.env.LOCALAPPDATA || app.getPath('appData'),
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
  documentPrint,
  officeConverter,
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
// `origin` is 'guest' for live-sharing visitors, whose edits are announced separately.
function call(command, args = {}, origin = 'local') {
  if (workerFailed && !quitting) startWorker();
  const result = new Promise((resolve, reject) => {
    const id = ++counter;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, command, args });
  });
  if (syncedCommands.has(command))
    result.then(
      () => {
        cloud?.localChanged();
        if (origin !== 'guest' && typeof args?.id === 'string') liveShare?.changed(args.id, 'host');
      },
      () => {},
    );
  return result;
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
  'searchContent',
  'patchBoard',
  'saveCamera',
  'setLastBoard',
  'importAsset',
  'removeBackground',
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
    const storageReady = seed();
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
            '.mjs': 'text/javascript',
            '.wasm': 'application/wasm',
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
        const a = await call('asset', { id, variant: variant || 'preview' });
        return assetResponse(a, request.headers.get('range'));
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
    if (!smoke) {
      win.once('ready-to-show', () => {
        attachWindowShadow(win, { BrowserWindow });
        win.show();
      });
    }
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
      if (input.type !== 'keyDown') return;
      if (fullscreenKeys.some((b) => matchesInput(b, input))) {
        event.preventDefault();
        if (!input.isAutoRepeat) win.setFullScreen(!win.isFullScreen());
        return;
      }
      if (input.control || input.alt || input.meta || input.shift) return;
      if (input.key === 'Escape' && win.isFullScreen()) {
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
    cloud = new CloudSync({
      call,
      root,
      config: cloudConfig(require('../package.json')),
      safeStorage,
      transaction: cloudTransaction,
      onStatus: (status) => {
        if (win && !win.isDestroyed()) win.webContents.send('canvas:cloud-status', status);
      },
      onPresence: (event) => {
        if (win && !win.isDestroyed()) win.webContents.send('canvas:presence', event);
      },
    });
    const cloudAction = (name, handler) =>
      ipcMain.handle('canvas:cloud-' + name, async (e, ...args) => {
        trusted(e);
        await storageReady;
        return handler(...args);
      });
    cloudAction('status', () => cloud.status);
    cloudAction('enable', (name) => cloud.enable(name));
    cloudAction('join', (code, name) => cloud.join(code, name));
    cloudAction('identify', (name) => cloud.identify(name));
    cloudAction('rename', (name) => cloud.rename(name));
    cloudAction('set-library', (on, name) => cloud.setLibrary(on, name));
    cloudAction('share-people', (kind, id) => cloud.sharePeople(kind, id));
    cloudAction('invite', (kind, id, role, name) => cloud.invite(kind, id, role, name));
    cloudAction('set-person-role', (share, person, role) =>
      cloud.setPersonRole(share, person, role),
    );
    cloudAction('remove-person', (share, person) => cloud.removePerson(share, person));
    cloudAction('set-board-access', (boardId, person, role) =>
      cloud.setBoardAccess(boardId, person, role === 'view' || role === 'edit' ? role : null),
    );
    cloudAction('stop-sharing', (share) => cloud.stopSharing(share));
    cloudAction('leave', (share) => cloud.leave(share));
    cloudAction('profile', () => cloud.profile());
    cloudAction('set-avatar', (asset) => cloud.setAvatar(asset || null));
    cloudAction('set-song', (asset, name) => cloud.setSong(asset || null, String(name || '')));
    cloudAction('set-publish-song', (on) => cloud.setPublishSong(on));
    cloudAction('profile-media', (person, avatar, song) =>
      cloud.profileMedia(person, Number(avatar) || 0, Number(song) || 0),
    );
    cloudAction('join-board', (boardId) => cloud.joinBoard(boardId));
    cloudAction('leave-board', () => cloud.leaveBoard());
    ipcMain.on('canvas:cloud-cursor', (e, data) => {
      trusted(e);
      cloud.sendCursor(data);
    });
    cloudAction('disable', () => cloud.disable());
    cloudAction('pairing-code', () => cloud.pairingCode());
    cloudAction('devices', () => cloud.devices());
    cloudAction('remove-device', (id) => cloud.removeDevice(id));
    cloudAction('sync-now', () => cloud.run().then(() => cloud.status));
    liveShare = new LiveShare({
      call,
      distDir: path.join(__dirname, '../dist'),
      onStatus: (status) => {
        if (win && !win.isDestroyed()) win.webContents.send('canvas:live-status', status);
      },
      onGuestEdit: refreshAfterGuestEdit,
    });
    const liveAction = (name, handler) =>
      ipcMain.handle('canvas:live-' + name, async (e, ...args) => {
        trusted(e);
        await storageReady;
        return handler(...args);
      });
    liveAction('status', () => liveShare.status());
    liveAction('start', (options) => liveShare.start(options || {}));
    liveAction('stop', () => liveShare.stop());
    liveAction('configure', (options) => liveShare.configure(options || {}));
    liveAction('answer', (id, allow, permission) => liveShare.answer(id, allow, permission));
    liveAction('guest-permission', (id, permission) =>
      liveShare.setGuestPermission(id, permission),
    );
    liveAction('remove-guest', (id) => liveShare.removeGuest(id));
    ipcMain.handle('canvas:mcp-status', (e) => {
      trusted(e);
      return mcp.status();
    });
    // The renderer is denied every web permission, including clipboard writes.
    ipcMain.handle('canvas:copy-text', (e, text) => {
      trusted(e);
      if (typeof text !== 'string' || text.length > 100000) throw Error('Invalid text');
      return clipboard.writeText(text);
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
    ipcMain.handle('canvas:invoke', async (e, command, args) => {
      trusted(e);
      if (!commands.has(command)) throw Error('Unknown command');
      await storageReady;
      if (externalPhase === 'apply' && !['library', 'loadBoard', 'saveCamera'].includes(command))
        throw Error('AI edit in progress. Retry after it completes.');
      return call(command, args);
    });
    ipcMain.handle('canvas:pick-media', async (e) => {
      trusted(e);
      const r = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'All files', extensions: ['*'] },
          {
            name: 'Documents',
            extensions: [
              'pdf',
              'doc',
              'docx',
              'rtf',
              'odt',
              'xls',
              'xlsx',
              'ods',
              'csv',
              'tsv',
              'txt',
              'md',
              'gdoc',
              'gsheet',
            ],
          },
          {
            name: 'Images and videos',
            extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'tiff', 'mp4', 'webm'],
          },
        ],
      });
      if (r.canceled) return [];
      const result = [];
      for (const file of r.filePaths)
        result.push(await call('importFile', { file, attachment: true }));
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
    const visualExport = createVisualExport({
      dialog,
      shell,
      getWindow: () => win,
      copyImage: (file) => {
        const image = nativeImage.createFromPath(file);
        if (image.isEmpty()) throw Error('The exported image could not be read.');
        clipboard.writeImage(image);
      },
    });
    documentPrint = createDocumentPrint({
      BrowserWindow,
      session,
      importAsset: (args) => call('importAsset', args),
    });
    officeConverter = createOfficeConverter({
      root,
      readAsset: (args) => call('asset', args),
      importAsset: (args) => call('importAsset', args),
      onProgress: (message) => {
        if (win && !win.isDestroyed()) win.webContents.send('canvas:office-progress', message);
      },
    });
    ipcMain.handle('canvas:print-document', async (event, args) => {
      trusted(event);
      await storageReady;
      if (externalPhase === 'apply') throw Error('AI edit in progress. Retry after it completes.');
      return documentPrint.print(args);
    });
    ipcMain.handle('canvas:convert-office', async (event, args) => {
      trusted(event);
      await storageReady;
      if (externalPhase === 'apply') throw Error('AI edit in progress. Retry after it completes.');
      return officeConverter.convert(args);
    });
    const assetDownload = createAssetDownload({
      dialog,
      getWindow: () => win,
      readAsset: (args) => call('asset', args),
    });
    ipcMain.handle('canvas:download-asset', (e, args) => {
      trusted(e);
      return assetDownload.save(args);
    });
    ipcMain.handle('canvas:asset-dimensions', async (e, id) => {
      trusted(e);
      const { width, height } = await call('asset', { id, variant: 'original' });
      return { width, height };
    });
    ipcMain.handle('canvas:export-image', (e, args) => {
      trusted(e);
      return visualExport.save(args);
    });
    ipcMain.handle('canvas:copy-export', (e, id) => {
      trusted(e);
      return visualExport.copy(id);
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
    ipcMain.handle('canvas:app-info', (e) => {
      trusted(e);
      return {
        version: app.getVersion(),
        libraryPath: root,
        backupsPath: path.join(root, 'backups'),
        loginItemSupported: app.isPackaged,
        openAtLogin: app.isPackaged && app.getLoginItemSettings().openAtLogin,
      };
    });
    ipcMain.handle('canvas:set-open-at-login', (e, enabled) => {
      trusted(e);
      if (!app.isPackaged) throw Error('Launch at login is available in the installed app.');
      app.setLoginItemSettings({ openAtLogin: enabled === true });
      return app.getLoginItemSettings().openAtLogin;
    });
    ipcMain.handle('canvas:open-folder', async (e, which) => {
      trusted(e);
      const folder = { library: root, backups: path.join(root, 'backups') }[which];
      if (!folder) throw Error('Unknown folder');
      const failure = await shell.openPath(folder);
      if (failure) throw Error(failure);
    });
    ipcMain.handle('canvas:export-library', async (e) => {
      trusted(e);
      const r = await dialog.showOpenDialog(win, {
        title: 'Export all boards',
        buttonLabel: 'Export here',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      const folder = r.filePaths[0];
      const { boards } = await call('library');
      const used = new Set(fs.readdirSync(folder).map((name) => name.toLowerCase()));
      let count = 0;
      for (const board of boards.filter((b) => !b.trashed)) {
        const base =
          String(board.name)
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
            .replace(/[. ]+$/, '')
            .trim()
            .slice(0, 80) || 'Board';
        let name = base + '.canvas';
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).canvas`;
        used.add(name.toLowerCase());
        await call('exportFile', { id: board.id, file: path.join(folder, name) });
        count++;
      }
      return { count, folder };
    });
    ipcMain.handle('canvas:licenses', (e) => {
      trusted(e);
      return bundledLicenses();
    });
    ipcMain.on('canvas:fullscreen-keys', (e, bindings) => {
      trusted(e);
      fullscreenKeys = cleanFullscreenKeys(bindings);
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
    win.on('closed', () => {
      documentPrint?.dispose();
      officeConverter?.dispose();
    });
    app.on('second-instance', () => {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    await Promise.all([storageReady, win.loadURL(dev || 'canvas-app://app/index.html')]);
    await mcp.start();
    if (!smoke)
      void cloud
        .start()
        .catch((e) => cloud.emit({ state: 'error', error: String(e.message || e) }));
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
    }
  })
  .catch((e) => {
    documentPrint?.dispose();
    officeConverter?.dispose();
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
  documentPrint?.dispose();
  officeConverter?.dispose();
  void mcp?.stop();
  cloud?.stop();
  void liveShare?.stop();
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
