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
  utilityProcess,
  webContents,
} = require('electron');
const { CloudSync, lookUpLocation } = require('./cloud-sync.cjs');
const {
  resolveServer,
  discover,
  checkServer,
  manualServer,
  saveServerChoice,
  terraCloud,
} = require('./cloud-config.cjs');
const { SCHEME, parseDeepLink, findDeepLink } = require('./deep-link.cjs');
const { LiveShare } = require('./live-share.cjs');
const { createImageClipboard } = require('./image-clipboard.cjs');
const { createVisualExport } = require('./visual-export.cjs');
const { createAssetDownload, assetResponse } = require('./document-assets.cjs');
const { createDocumentPrint } = require('./document-print.cjs');
const {
  createOfficeConverter,
  officeLocation,
  installOffice,
  VERSION: officeVersion,
} = require('./office-converter.cjs');
const { attachWindowShadow } = require('./window-shadow.cjs');
const { fetchPreview } = require('./link-preview.cjs');
const { downloadSongLink, YT_DLP } = require('./song-link.cjs');
const { createOcr, textRecognitionAvailable } = require('./ocr.cjs');
const { createHtmlCards, embedRequest, fromEmbed } = require('./html-cards.cjs');
const { browserSession, hardenWebviews, guestOf } = require('./browser-frames.cjs');
const { createLocalFiles, registerLocalFiles } = require('./local-files.cjs');
const { createShellHelper } = require('./shell-helper.cjs');
const { acceptLanguages, spellcheckLanguages } = require('./system-languages.cjs');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { libraryRoot, userDataBase } = require('./storage-paths.cjs');
const {
  integrateAppImage,
  autostartEnabled,
  setAutostart,
  systemEnv,
} = require('./linux-desktop.cjs');
const { createAppUpdater, installsUpdates } = require('./app-updater.cjs');
const { collectLicenses } = require('./licenses.cjs');
const { createExtensions } = require('./extensions.cjs');
const { createBackgroundRemoval, removeAssetBackground } = require('./background-removal.cjs');
const { MiroClient, boardIdFrom, importBoard: importMiroBoard } = require('./miro-import.cjs');
protocol.registerSchemesAsPrivileged([
  { scheme: 'canvas-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  // HTML embeds: their own origin, framed with a sandbox (html-cards.cjs).
  { scheme: 'terra-html', privileges: { standard: true, secure: true } },
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
// Everything the app ships, with each package's declared license.
function bundledLicenses() {
  licenseList ||= collectLicenses({ appPath: app.getAppPath(), extensionsRoot });
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
let ocr = null;
let liveShare = null;
let shellHelper = null;
let localFiles = null;
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
  localAppData: userDataBase({ home: app.getPath('home'), appData: app.getPath('appData') }),
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
// Settings → Extensions (extensions.cjs). Installed copies keep extensions next
// to the Library and download them; repository builds keep them under release/
// and install from the build output there, so development needs no downloads.
const installedCopy =
  app.isPackaged && require('../package.json').terraDistribution === 'installed';
const repository = app.isPackaged
  ? path.resolve(path.dirname(app.getPath('exe')), '../..')
  : app.getAppPath();
const extensionsRoot = path.resolve(
  process.env.TERRA_EXTENSIONS_DIR ||
    (installedCopy
      ? path.join(path.dirname(root), 'Extensions')
      : path.join(repository, 'release', 'installed-extensions')),
);
const extensionSource =
  process.env.TERRA_EXTENSIONS_SOURCE || !installedCopy
    ? {
        dir: path.resolve(
          process.env.TERRA_EXTENSIONS_SOURCE || path.join(repository, 'release', 'extensions'),
        ),
      }
    : { remote: true };
function extensionCatalog() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, 'generated', 'extensions.json'), 'utf8'),
    );
  } catch {
    return { extensions: [] };
  }
}
let win,
  documentPrint,
  officeConverter,
  extensions,
  backgroundRemoval,
  worker,
  closed = false,
  quitting = false,
  updater,
  installUpdate = false,
  counter = 0,
  workerFailed = false;
let readyResolve;
const rendererReady = new Promise((resolve) => (readyResolve = resolve));
const serverStatus = (config, locked) =>
  config && { name: config.name, kind: config.kind, locked, address: config.address ?? null };
// A terraboard:// link only reaches the window; Settings asks the person before anything changes.
// The sign-in callback goes to the sign-in waiting for it instead, and is ignored otherwise.
async function sendDeepLink(argv) {
  const link = parseDeepLink(findDeepLink(argv));
  if (!link) return;
  if (link.kind === 'auth') {
    await cloud?.finishOAuth(link.url).catch(() => false);
    return;
  }
  await rendererReady;
  if (win && !win.isDestroyed()) win.webContents.send('canvas:deep-link', link);
}
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
  'boardHistory',
  'patchBoard',
  'saveCamera',
  'setLastBoard',
  'importAsset',
  'removeBackground',
  'assetLinks',
  'assetInfo',
  'boardSyncs',
  'boardInfo',
]);
const albumImageExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'tif', 'tiff'];
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
    // Registered at once: a link opened while this copy is still starting must not be lost.
    app.on('second-instance', (_event, argv) => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
      void sendDeepLink(argv);
    });
    // An AppImage first gives itself an applications-menu entry, which Linux
    // desktops need before they can hand it terraboard:// links.
    if (app.isPackaged && !smoke && process.platform === 'linux' && process.env.APPIMAGE)
      try {
        integrateAppImage({
          appImage: process.env.APPIMAGE,
          dataHome: userDataBase({ home: app.getPath('home'), appData: app.getPath('appData') }),
          icon: path.join(__dirname, '../assets/icon.png'),
        });
      } catch (e) {
        console.error('Desktop entry:', e.message);
      }
    // Only the installed app claims terraboard:// links; a dev build would take them from it.
    // TERRA_DEV_PROTOCOL=1 lets a dev build take them, for testing Google sign-in.
    if (app.isPackaged && !smoke && !app.isDefaultProtocolClient(SCHEME))
      app.setAsDefaultProtocolClient(SCHEME);
    else if (!app.isPackaged && process.env.TERRA_DEV_PROTOCOL === '1')
      app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
    startWorker();
    const storageReady = seed();
    const officeProgress = (message) => {
      if (win && !win.isDestroyed()) win.webContents.send('canvas:office-progress', message);
    };
    const downloads = session.fromPartition('terra-downloads', { cache: false });
    extensions = createExtensions({
      root: extensionsRoot,
      catalog: extensionCatalog(),
      source: extensionSource,
      fetch: (url, options) => downloads.fetch(url, options),
      installers: {
        // The board's progress line clears whether the install finished,
        // failed or was started from Settings.
        libreoffice: (job) =>
          installOffice({ ...job, onText: officeProgress }).finally(() => officeProgress('')),
      },
      // A LibreOffice installed in Windows needs nothing from the extension.
      systemInstalled: (id) => id === 'office-files' && officeLocation()?.system === true,
      beforeRemove: async (id) => {
        if (id === 'background-removal') await backgroundRemoval.stop();
      },
      onChange: (list) => {
        licenseList = null;
        if (win && !win.isDestroyed()) win.webContents.send('canvas:extensions-changed', list);
      },
    });
    // Leftovers of interrupted installs go; LibreOffice extracted by 0.1.28 and
    // earlier moves into the Office files extension.
    void extensions
      .cleanup()
      .then(() =>
        extensions.adopt('office-files', path.join(root, 'tools', `libreoffice-${officeVersion}`)),
      )
      .catch(() => {});
    backgroundRemoval = createBackgroundRemoval({
      fork: (modulePath) =>
        utilityProcess.fork(modulePath, [], { serviceName: 'Terra Board background removal' }),
      location: () => {
        const dir = extensions.path('background-removal');
        return dir && { model: path.join(dir, 'u2net.onnx'), runtime: dir };
      },
    });
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
    // The app ships only Chromium's English locale, so websites (browser frames,
    // YouTube, embeds' resources) and the spellchecker get the system's
    // languages rather than English.
    const preferred = app.getPreferredSystemLanguages();
    const languages = acceptLanguages(preferred);
    if (languages)
      session.defaultSession.setUserAgent(session.defaultSession.getUserAgent(), languages);
    const dictionaries = spellcheckLanguages(
      preferred,
      session.defaultSession.availableSpellCheckerLanguages,
    );
    if (dictionaries.length) session.defaultSession.setSpellCheckerLanguages(dictionaries);
    // Before any <webview> opens, so frames never run on an unconfigured session.
    browserSession(session, languages);
    const htmlCards = createHtmlCards({
      BrowserWindow,
      session,
      call,
      browserSession: () => browserSession(session, languages),
    });
    protocol.handle('terra-html', htmlCards.handle);
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
        // The preload offers text recognition only where it works (Tesseract
        // installed on Linux); it reads this flag from process.argv.
        additionalArguments: textRecognitionAvailable(process.platform, systemEnv())
          ? ['--terra-text-recognition']
          : [],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Browser frames; every guest is hardened in browser-frames.cjs.
        webviewTag: true,
      },
    });
    hardenWebviews(win);
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
      // HTML embeds reach the web, never the app's own schemes or media.
      if (fromEmbed(details)) {
        cb({ cancel: !embedRequest(details) });
        return;
      }
      const allowed =
        ['canvas-app:', 'canvas-media:', 'data:', 'blob:', 'devtools:'].some((s) =>
          details.url.startsWith(s),
        ) ||
        embedRequest(details) ||
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
    ipcMain.handle('canvas:html-page', (e, html) => {
      trusted(e);
      return htmlCards.register(html).url;
    });
    ipcMain.handle('canvas:html-snapshot', (e, args) => {
      trusted(e);
      return htmlCards.snapshot(args);
    });
    ipcMain.handle('canvas:browser-snapshot', (e, args) => {
      trusted(e);
      return htmlCards.snapshotUrl(args);
    });
    ipcMain.handle('canvas:browser-capture', (e, id) => {
      trusted(e);
      return htmlCards.captureContents(guestOf(win, webContents, id));
    });
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
    mcp = new McpService({
      root,
      call,
      transaction: mcpTransaction,
      services: { captureHtml: (args) => htmlCards.snapshot(args), cloud: () => cloud },
    });
    const packageJson = require('../package.json');
    const chosenServer = () => resolveServer({ env: process.env, root, packageJson });
    const startServer = chosenServer();
    cloud = new CloudSync({
      call,
      root,
      config: startServer.config,
      server: serverStatus(startServer.config, startServer.locked),
      // Sessions saved before the app recorded their server belong to the one it used then.
      legacyServerUrl:
        process.env.TERRA_CLOUD_URL && process.env.TERRA_CLOUD_KEY
          ? process.env.TERRA_CLOUD_URL
          : packageJson.terraCloud?.url,
      safeStorage,
      transaction: cloudTransaction,
      appVersion: app.getVersion(),
      locate: lookUpLocation,
      // Google and Microsoft refuse sign-in inside an app window, so it happens in the
      // system browser, which comes back through terraboard://auth/callback.
      openUrl: (url) => {
        if (
          new URL(url).protocol !== 'https:' &&
          !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)
        )
          throw Error('Only secure sign-in pages can be opened');
        return shell.openExternal(url);
      },
      onStatus: (status) => {
        if (win && !win.isDestroyed()) win.webContents.send('canvas:cloud-status', status);
      },
      onPresence: (event) => {
        if (win && !win.isDestroyed()) win.webContents.send('canvas:presence', event);
      },
    });
    // Settings → About: whether to check GitHub for new versions on its own.
    const updateSettings = path.join(root, 'settings', 'updates.json');
    let automaticUpdates = true;
    try {
      automaticUpdates = JSON.parse(fs.readFileSync(updateSettings, 'utf8')).automatic !== false;
    } catch {}
    updater = createAppUpdater({
      app,
      automatic: automaticUpdates,
      enabled:
        app.isPackaged &&
        require('../package.json').terraDistribution === 'installed' &&
        installsUpdates() &&
        !smoke,
      // Every packaged copy, including ones built from source, hears about new versions.
      notify: app.isPackaged && !smoke,
      // Its own session: the window's session blocks outside requests.
      fetch: (url, options) =>
        session.fromPartition('terra-updates', { cache: false }).fetch(url, options),
      onStatus: (status) => {
        if (win && !win.isDestroyed()) win.webContents.send('canvas:update-status', status);
      },
    });
    ipcMain.handle('canvas:update-status', (e) => {
      trusted(e);
      return updater.status();
    });
    ipcMain.handle('canvas:update-check', (e) => {
      trusted(e);
      updater.check();
      return updater.status();
    });
    ipcMain.handle('canvas:update-automatic', (e, on) => {
      trusted(e);
      if (typeof on !== 'boolean') throw Error('Expected on or off.');
      fs.mkdirSync(path.dirname(updateSettings), { recursive: true });
      fs.writeFileSync(updateSettings, JSON.stringify({ automatic: on }));
      return updater.setAutomatic(on);
    });
    // Saves and closes like a normal quit, then installs once the library is closed.
    ipcMain.handle('canvas:update-install', (e) => {
      trusted(e);
      if (updater.status().state !== 'ready') return false;
      installUpdate = true;
      win.close();
      return true;
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
    cloudAction('remove-from-cloud', (boardId) => cloud.removeFromCloud(boardId));
    cloudAction('upload', (kind, id, name) =>
      cloud.uploadToCloud(kind === 'folder' ? 'folder' : 'board', String(id), name),
    );
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
    ipcMain.on('canvas:cloud-edit', (e, data) => {
      trusted(e);
      cloud.sendEdit(data);
    });
    cloudAction('disable', () => cloud.disable());
    cloudAction('devices', () => cloud.devices());
    cloudAction('remove-device', (id) => cloud.removeDevice(String(id)));
    // A claim that did not finish (offline after signing in) is retried by a fresh start.
    cloudAction('sync-now', () =>
      (cloud.claimWaiting() ? cloud.start() : cloud.run()).then(() => cloud.status),
    );
    const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
    cloudAction('send-code', (email) => cloud.sendEmailCode(text(email, 254)));
    cloudAction('verify-code', (email, code) =>
      cloud.verifyEmailCode(text(email, 254), text(code, 20)),
    );
    cloudAction('sign-in-with', (provider) =>
      cloud.signInWithProvider(provider === 'microsoft' ? 'microsoft' : 'google'),
    );
    cloudAction('cancel-sign-in', () => cloud.cancelSignIn());
    cloudAction('sign-out', () => cloud.signOut());
    cloudAction('delete-cloud-data', () => cloud.deleteCloudData());
    cloudAction('sign-in-methods', () => cloud.loadMethods().then(() => cloud.status));
    // Server requests go through their own session: the window's session blocks outside requests.
    const serverFetch = (url, options) =>
      session.fromPartition('terra-cloud', { cache: false }).fetch(url, options);
    // The renderer only names a server; what it is gets worked out here.
    const serverFromInput = async (input) => {
      if (input?.terra === true) {
        const config = terraCloud(packageJson);
        if (!config) throw Error('This copy of Terra Board has no Terra Cloud address.');
        return { config, terra: true };
      }
      if (typeof input?.address === 'string')
        return { config: await discover(input.address, { fetch: serverFetch }) };
      if (typeof input?.url === 'string' && typeof input?.key === 'string')
        return { config: manualServer(input.url, input.key) };
      throw Error('Enter the server address.');
    };
    cloudAction('server-test', async (input) => {
      const { config } = await serverFromInput(input);
      const { billing } = await checkServer(config, { fetch: serverFetch });
      return { name: config.name, host: new URL(config.url).host, billing };
    });
    // { turnOffSync: true } turns sync off once the new server has passed its check, so a
    // failed check leaves sync as it was. Without it, a switch with sync on is refused.
    cloudAction('server-set', async (input, options) => {
      const current = chosenServer();
      if (current.locked) throw Error('Your organization manages the server for this computer.');
      if (current.source === 'env')
        throw Error('This copy of Terra Board is set to a development server.');
      const { config, terra } = await serverFromInput(input);
      // The built-in server ships with this app, so it is not checked.
      if (!terra) await checkServer(config, { fetch: serverFetch });
      // Accounts belong to one server: switching signs out (which also turns sync off).
      if (options?.turnOffSync === true) {
        if ((await cloud.checkAccount()).state === 'signedIn') await cloud.signOut();
        else if ((await cloud.local()).identity) await cloud.disable();
      }
      // Reconfigure before saving: it refuses while sync is on, and then nothing has been saved.
      await cloud.reconfigure(config, serverStatus(config, false));
      saveServerChoice(root, terra ? 'terra' : config);
      return cloud.status;
    });
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
    ipcMain.handle('canvas:song-from-link', (e, url) => {
      trusted(e);
      const dir = extensions.path('song-links');
      return downloadSongLink(url, dir && path.join(dir, YT_DLP));
    });
    ipcMain.handle('canvas:copy-text', (e, text) => {
      trusted(e);
      if (typeof text !== 'string' || text.length > 10000000) throw Error('Invalid text');
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
      // Cut-outs run in a utility process, which only the main process can start.
      if (command === 'removeBackground')
        return removeAssetBackground(args, {
          readAsset: (a) => call('asset', a),
          importAsset: (a) => call('importAsset', a),
          run: backgroundRemoval.run,
        });
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
    // Images for an album: chosen here, or dropped (paths from the drop). With
    // `link`, the album keeps the file where it is and the library only a preview.
    ipcMain.handle('canvas:import-album-files', async (e, { paths, link } = {}) => {
      trusted(e);
      let files = paths;
      if (files === undefined) {
        const r = await dialog.showOpenDialog(win, {
          title: 'Add images to the album',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Images', extensions: albumImageExtensions }],
        });
        if (r.canceled) return [];
        files = r.filePaths;
      }
      if (
        !Array.isArray(files) ||
        files.length > 2000 ||
        !files.every((f) => typeof f === 'string')
      )
        throw Error('Invalid files');
      const result = [];
      for (const file of files) {
        if (!albumImageExtensions.includes(path.extname(file).slice(1).toLowerCase()))
          throw Error(
            `${path.basename(file)} is not an image. Albums hold PNG, JPEG, WebP, GIF, AVIF and TIFF.`,
          );
        result.push(await call('importFile', { file, attachment: true, link: link === true }));
      }
      return result;
    });
    ipcMain.handle('canvas:locate-asset', async (e, { id, name } = {}) => {
      trusted(e);
      const r = await dialog.showOpenDialog(win, {
        title: `Locate ${typeof name === 'string' ? name : 'the image'}`,
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: albumImageExtensions }],
      });
      return r.canceled ? null : call('relinkAsset', { id, file: r.filePaths[0] });
    });
    ipcMain.handle('canvas:import-board', async (e) => {
      trusted(e);
      const r = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'Terra Board board', extensions: ['canvas'] }],
      });
      return r.canceled ? null : call('importFile', { file: r.filePaths[0] });
    });
    // Import from Miro (miro-import.cjs). The access token stays in this process;
    // "Remember" keeps it encrypted with the Windows user's key. Teams learned
    // from board links are kept too (just ids and names), so their boards list.
    const miroFile = path.join(root, 'settings', 'miro.json'),
      miroSession = session.fromPartition('terra-miro', { cache: false }),
      miroFetch = (url, options) => miroSession.fetch(url, options);
    let miroToken = '',
      miroTeams = null;
    const readMiro = () => {
      try {
        return JSON.parse(fs.readFileSync(miroFile, 'utf8')) || {};
      } catch {
        return {};
      }
    };
    const savedMiroToken = () => {
      try {
        const saved = readMiro().token;
        return saved && safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(saved, 'base64'))
          : '';
      } catch {
        return '';
      }
    };
    const knownMiroTeams = () =>
      (miroTeams ??= Array.isArray(readMiro().teams) ? readMiro().teams : []);
    const saveMiro = (patch) => {
      const next = { ...readMiro(), ...patch };
      if (!next.token) delete next.token;
      fs.writeFileSync(miroFile, JSON.stringify(next));
    };
    const miroClient = () => {
      const token = miroToken || savedMiroToken();
      if (!token) throw Error('Add a Miro access token first.');
      return new MiroClient(token, { fetch: miroFetch });
    };
    const listMiro = async (client) => {
      const r = await client.boards(knownMiroTeams());
      miroTeams = r.teams;
      saveMiro({ teams: r.teams });
      return r.boards;
    };
    ipcMain.handle('canvas:miro-status', (e) => {
      trusted(e);
      return {
        saved: !!(miroToken || savedMiroToken()),
        canRemember: safeStorage.isEncryptionAvailable(),
      };
    });
    ipcMain.handle('canvas:miro-connect', async (e, { token, remember } = {}) => {
      trusted(e);
      const client = new MiroClient(String(token || '').slice(0, 4000), { fetch: miroFetch });
      if (!client.token) throw Error('Paste the access token from Miro.');
      const boards = await listMiro(client);
      miroToken = client.token;
      saveMiro({
        token:
          remember && safeStorage.isEncryptionAvailable()
            ? safeStorage.encryptString(client.token).toString('base64')
            : undefined,
      });
      return boards;
    });
    ipcMain.handle('canvas:miro-boards', (e) => {
      trusted(e);
      return listMiro(miroClient());
    });
    // A pasted board link adds its whole team to the list.
    ipcMain.handle('canvas:miro-add', async (e, link) => {
      trusted(e);
      const client = miroClient(),
        id = boardIdFrom(link),
        team = await client.teamOf(id);
      if (team && !knownMiroTeams().some((t) => t.id === team.id))
        miroTeams = [...knownMiroTeams(), team];
      return { id, boards: await listMiro(client) };
    });
    ipcMain.handle('canvas:miro-forget', (e) => {
      trusted(e);
      miroToken = '';
      miroTeams = [];
      fs.rmSync(miroFile, { force: true });
      return true;
    });
    ipcMain.handle('canvas:miro-import', async (e, { ids } = {}) => {
      trusted(e);
      if (!Array.isArray(ids) || !ids.length || ids.length > 200)
        throw Error('Choose boards to import.');
      await storageReady;
      const client = miroClient(),
        results = [];
      for (const [index, raw] of ids.entries()) {
        if (externalPhase === 'apply')
          throw Error('AI edit in progress. Retry after it completes.');
        try {
          const r = await importMiroBoard({
            client,
            boardId: boardIdFrom(raw),
            call,
            onProgress: (p) => {
              if (win && !win.isDestroyed())
                win.webContents.send('canvas:miro-progress', { ...p, index, count: ids.length });
            },
          });
          results.push({ id: raw, board: r.board, objects: r.objects, skipped: r.skipped });
        } catch (error) {
          // A rejected token fails every board; other errors stay with their board.
          if (/access token/.test(error.message)) throw error;
          results.push({ id: raw, error: error.message });
        }
      }
      return results;
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
      // The first conversion installs the Office files extension, as the
      // converter did before it was an extension; the board shows its progress.
      runtime: async () => {
        const location = () =>
          officeLocation({ extensionDir: extensions.path('office-files'), legacyRoot: root });
        if (!location()) await extensions.install('office-files');
        return location().executable;
      },
      readAsset: (args) => call('asset', args),
      importAsset: (args) => call('importAsset', args),
      onProgress: officeProgress,
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
    ocr = createOcr({
      loadAsset: (id) => call('asset', { id, variant: 'original' }),
      // Linux: the system's Tesseract, without the AppImage's libraries.
      tesseract: {
        env: systemEnv(),
        preferredLanguages: () => app.getPreferredSystemLanguages(),
      },
    });
    ipcMain.handle('canvas:recognize-asset', (e, id) => {
      trusted(e);
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw Error('Invalid asset');
      return ocr.recognizeAsset(id);
    });
    ipcMain.handle('canvas:recognize-image', (e, bytes) => {
      trusted(e);
      return ocr.recognizeImage(bytes);
    });
    ipcMain.handle('canvas:asset-dimensions', async (e, id) => {
      trusted(e);
      // The row holds the original's size; a linked original may be missing.
      const { width, height } = await call('asset', { id, variant: 'preview' });
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
        openAtLogin:
          app.isPackaged &&
          (process.platform === 'linux'
            ? autostartEnabled({ configHome: app.getPath('appData') })
            : app.getLoginItemSettings().openAtLogin),
      };
    });
    ipcMain.handle('canvas:set-open-at-login', (e, enabled) => {
      trusted(e);
      if (!app.isPackaged) throw Error('Launch at login is available in the installed app.');
      // Electron's login items exist on Windows and macOS; Linux desktops start
      // the entries in ~/.config/autostart. An AppImage starts as its own file.
      if (process.platform === 'linux')
        return setAutostart({
          configHome: app.getPath('appData'),
          executable: process.env.APPIMAGE || app.getPath('exe'),
          enabled: enabled === true,
        });
      app.setLoginItemSettings({ openAtLogin: enabled === true });
      return app.getLoginItemSettings().openAtLogin;
    });
    // Folder frames and file tiles: live folders on this computer.
    shellHelper = createShellHelper();
    localFiles = createLocalFiles({
      getPath: (name) => app.getPath(name),
      helper: shellHelper,
      shell,
      nativeImage,
      getFileIcon: (file, options) => app.getFileIcon(file, options),
      sharp: require('sharp'),
      readAsset: (args) => call('asset', args),
      importFile: (file) => call('importFile', { file, attachment: true }),
      pickFolder: async (defaultPath) => {
        const r = await dialog.showOpenDialog(win, {
          title: 'Choose a folder to show on the board',
          defaultPath,
          properties: ['openDirectory', 'createDirectory'],
        });
        return r.canceled ? null : r.filePaths[0] || null;
      },
      send: (channel, data) => {
        if (win && !win.isDestroyed()) win.webContents.send(channel, data);
      },
    });
    registerLocalFiles({ ipcMain, trusted, files: localFiles });
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
    // Settings → Extensions. Progress and every change arrive as
    // canvas:extensions-changed.
    ipcMain.handle('canvas:extensions-list', (e) => {
      trusted(e);
      return extensions.list();
    });
    ipcMain.handle('canvas:extensions-install', async (e, id) => {
      trusted(e);
      await extensions.install(String(id));
    });
    ipcMain.handle('canvas:extensions-cancel', (e, id) => {
      trusted(e);
      extensions.cancel(String(id));
    });
    ipcMain.handle('canvas:extensions-remove', async (e, id) => {
      trusted(e);
      await extensions.remove(String(id));
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
      extensions?.cancelAll();
      void backgroundRemoval?.stop();
    });
    void sendDeepLink(process.argv);
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
          cloudServer: cloud.status.server?.kind ?? null,
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
  updater?.stop();
  const finish = () => {
    if (!(installUpdate && updater?.install())) app.quit();
  };
  documentPrint?.dispose();
  officeConverter?.dispose();
  extensions?.cancelAll();
  void backgroundRemoval?.stop();
  ocr?.dispose();
  localFiles?.unwatchAll();
  shellHelper?.stop();
  void mcp?.stop();
  cloud?.stop();
  void liveShare?.stop();
  if (workerFailed) {
    worker.terminate();
    finish();
    return;
  }
  call('close').finally(() => {
    worker.terminate();
    finish();
  });
});
