// Browser frames: websites on the board, each like a browser tab. Pages run in
// <webview> guests that share one persistent session, so sign-ins last across
// restarts, and that never get the app's preload, Node or session.
const partition = 'persist:terra-browser';
const allowedPermissions = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock'];
const isWebUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);

let configured = null;
function browserSession(session) {
  if (configured) return configured;
  const s = session.fromPartition(partition);
  s.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(allowedPermissions.includes(permission)),
  );
  s.setPermissionCheckHandler((_wc, permission) => allowedPermissions.includes(permission));
  // Present as the Chrome it is; some sign-in pages refuse "embedded" browsers.
  s.setUserAgent(plainUserAgent(s.getUserAgent()));
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

module.exports = { partition, browserSession, hardenWebviews, guestOf, plainUserAgent, isWebUrl };
