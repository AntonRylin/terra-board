// Browser frames: websites on the board, each like a browser tab. Pages run in
// <webview> guests that share one persistent session, so sign-ins last across
// restarts, and that never get the app's preload, Node or session.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const partition = 'persist:terra-browser';
// Sites whose pages are private once signed in (Telegram Web): Terra never
// takes pictures of them, as a picture would be saved in the board and synced.
const privateHosts = new Set(['web.telegram.org', 'webk.telegram.org', 'webz.telegram.org']);
function privateSite(url) {
  try {
    return privateHosts.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}
const allowedPermissions = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock'];
const isWebUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);

let configured = null;
function browserSession(session, languages = '') {
  if (configured) return configured;
  const s = session.fromPartition(partition);
  s.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(allowedPermissions.includes(permission)),
  );
  s.setPermissionCheckHandler((_wc, permission) => allowedPermissions.includes(permission));
  // Present as the Chrome it is; some sign-in pages refuse "embedded" browsers.
  s.setUserAgent(plainUserAgent(s.getUserAgent()), languages || undefined);
  configured = s;
  return s;
}
const plainUserAgent = (agent) =>
  agent.replace(/ (?:Electron|[\w-]*terra[\w-]*|Terra Board)\/[\w.-]+/gi, '');

// Links that open a tab stay in the frame, like a browser tab would show them;
// sign-in popups (window.open with features) open as small windows.
function openHandler(contents) {
  return ({ url, disposition }) => {
    if (!isWebUrl(url)) return { action: 'deny' };
    if (disposition === 'new-window')
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true },
      };
    void contents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  };
}

function hardenWebviews(win) {
  const host = win.webContents;
  host.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    if (params.partition !== partition || !isWebUrl(params.src)) event.preventDefault();
  });
  host.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(openHandler(contents));
    contents.on('did-create-window', (child) => {
      child.setMenu(null);
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

// A browser frame of this window, by the ID its <webview> reports.
function guestOf(win, webContents, id) {
  const contents = Number.isInteger(id) ? webContents.fromId(id) : null;
  if (
    !contents ||
    contents.isDestroyed() ||
    contents.getType() !== 'webview' ||
    contents.hostWebContents !== win.webContents
  )
    throw Error('This is not a browser frame on the board.');
  return contents;
}

// Files a page downloads go to Downloads, as in a browser, without asking;
// `onSaved` lets the board offer to add them.
function saveDownloads(session, { folder, onSaved }) {
  session.on('will-download', (_event, item) => {
    const dir = folder();
    const name =
      path
        .basename(item.getFilename() || 'Download')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
        .slice(0, 200) || 'Download';
    const ext = path.extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    let file = path.join(dir, name);
    for (let i = 2; fs.existsSync(file) && i < 10000; i++)
      file = path.join(dir, `${base} (${i})${ext}`);
    item.setSavePath(file);
    item.once('done', (_e, state) => {
      if (state === 'completed') onSaved({ path: file, name: path.basename(file) });
    });
  });
}

// Board pictures and documents dropped on a running browser frame, as if
// dragged from Explorer: the page gets a real drop with the files (Chromium's
// DevTools protocol), so sites like Telegram Web attach them.
async function dropFiles(contents, { files, x, y }) {
  const dbg = contents.debugger;
  const attached = dbg.isAttached();
  if (!attached) dbg.attach('1.3');
  const data = { items: [], files, dragOperationsMask: 1 };
  const send = (type) => dbg.sendCommand('Input.dispatchDragEvent', { type, x, y, data });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await send('dragEnter');
    await send('dragOver');
    // Pages often show their drop area on dragenter; let it appear first.
    await wait(160);
    await send('dragOver');
    await wait(60);
    await send('drop');
  } finally {
    if (!attached && dbg.isAttached()) dbg.detach();
  }
}
// Copies made for drops go an hour later (the page may still be uploading
// them), and anything older than a day when the app starts.
function sweepDrops(folder, age = 24 * 3600 * 1000) {
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names) {
    const dir = path.join(folder, name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > age)
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* In use; next time. */
    }
  }
}
// Copies of board assets, under their own names, for dropping into a page.
async function stageAssets(items, { readAsset, folder }) {
  if (!Array.isArray(items) || !items.length || items.length > 50) throw Error('Invalid items');
  const dir = path.join(folder, randomUUID());
  await fs.promises.mkdir(dir, { recursive: true });
  const files = [];
  for (const item of items) {
    if (!item || !/^[a-f0-9]{64}$/.test(String(item.assetId))) throw Error('Invalid item');
    const asset = await readAsset({ id: item.assetId, variant: 'original' });
    const { fileName } = require('./telegram.cjs');
    const file = path.join(
      dir,
      `${files.length + 1}-${fileName(item.name || asset.name, asset.mime)}`,
    );
    await fs.promises.copyFile(asset.file, file);
    files.push(file);
  }
  setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), 3600 * 1000).unref();
  return files;
}

module.exports = {
  sweepDrops,
  privateSite,
  saveDownloads,
  dropFiles,
  stageAssets,
  partition,
  browserSession,
  hardenWebviews,
  guestOf,
  plainUserAgent,
  isWebUrl,
};
