const { randomUUID } = require('node:crypto');

// HTML embeds (src/canvas/html-card.ts). Their pages are served from
// terra-html://page/<token>/ so they never share the app's origin or its
// Content-Security-Policy; the board frames them with a sandbox that gives them
// an opaque origin. Pictures for the board are captured in an offscreen window
// with its own in-memory session.
const scheme = 'terra-html';
const sourceLimit = 500000;
const viewport = { min: 40, max: 4096 };
const pageLimit = 64;
const captureTimeout = 8000;
// Time after loading for fonts, scripts and entry animations to settle.
const settle = 700;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isPageUrl = (url) => typeof url === 'string' && url.startsWith(scheme + '://');

function frameUrl(details) {
  try {
    return details.frame?.url || '';
  } catch {
    return '';
  }
}
// Requests made by a running embed, which only embedRequest may allow.
const fromEmbed = (details) => isPageUrl(frameUrl(details));
// Network requests a running embed may make. Pages load scripts, styles, fonts
// and data from the web, but cannot open frames or reach local schemes.
function embedRequest(details) {
  if (isPageUrl(details.url)) return details.resourceType !== 'mainFrame';
  if (!fromEmbed(details)) return false;
  if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') return false;
  return /^(https?|wss?):/.test(details.url) || /^(data|blob):/.test(details.url);
}

function createHtmlCards({ BrowserWindow, session, call }) {
  const pages = new Map();
  function register(html) {
    if (typeof html !== 'string' || html.length > sourceLimit)
      throw Error('HTML embeds hold up to 500,000 characters.');
    const token = randomUUID();
    pages.set(token, html);
    // Frames reload their page from here; keep the most recent ones.
    while (pages.size > pageLimit) pages.delete(pages.keys().next().value);
    return { token, url: `${scheme}://page/${token}/` };
  }
  function handle(request) {
    try {
      const u = new URL(request.url),
        match = /^\/([\w-]{36})\/$/.exec(u.pathname);
      const html = u.hostname === 'page' && match ? pages.get(match[1]) : undefined;
      if (html === undefined) return new Response('Not found', { status: 404 });
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }

  let captureSession = null;
  function snapshotSession() {
    if (captureSession) return captureSession;
    // No "persist:" prefix: cookies and storage last only while the app runs.
    const s = session.fromPartition('terra-html-snapshot');
    s.protocol.handle(scheme, handle);
    s.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    s.setPermissionCheckHandler(() => false);
    s.on('will-download', (event) => event.preventDefault());
    s.webRequest.onBeforeRequest((details, cb) => {
      const allowed = isPageUrl(details.url)
        ? true
        : details.resourceType !== 'mainFrame' &&
          details.resourceType !== 'subFrame' &&
          /^(https?|wss?|data|blob):/.test(details.url);
      cb({ cancel: !allowed });
    });
    captureSession = s;
    return s;
  }

  async function capture({ html, width, height }) {
    if (
      ![width, height].every((v) => Number.isInteger(v) && v >= viewport.min && v <= viewport.max)
    )
      throw Error('Invalid HTML embed size.');
    const { token, url } = register(html);
    // Twice the CSS size for sharp zooming, within a 4096-pixel picture.
    const scale = Math.min(2, viewport.max / Math.max(width, height));
    const win = new BrowserWindow({
      show: false,
      frame: false,
      useContentSize: true,
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      backgroundColor: '#ffffff',
      webPreferences: {
        offscreen: true,
        session: snapshotSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        disableDialogs: true,
        spellcheck: false,
        backgroundThrottling: false,
        zoomFactor: scale,
      },
    });
    const contents = win.webContents;
    let painted = null;
    contents.on('paint', (_event, _dirty, image) => {
      painted = image;
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame) event.preventDefault();
    });
    contents.setAudioMuted(true);
    try {
      await Promise.race([contents.loadURL(url).catch(() => {}), delay(captureTimeout)]);
      if (win.isDestroyed()) throw Error('The HTML embed could not be captured.');
      contents.setZoomFactor(scale);
      await delay(settle);
      contents.invalidate();
      await delay(50);
      let image = await contents.capturePage().catch(() => null);
      if (!image || image.isEmpty()) image = painted;
      if (!image || image.isEmpty()) throw Error('The HTML embed could not be captured.');
      // Window sizes round through the display scale; trim or fit to the exact picture.
      const target = { width: Math.round(width * scale), height: Math.round(height * scale) },
        size = image.getSize();
      if (size.width !== target.width || size.height !== target.height)
        image =
          size.width >= target.width && size.height >= target.height
            ? image.crop({ x: 0, y: 0, ...target })
            : image.resize({ ...target, quality: 'best' });
      const bytes = image.toPNG();
      return (await call('importAsset', { name: 'HTML embed.png', bytes })).id;
    } finally {
      pages.delete(token);
      if (!win.isDestroyed()) win.destroy();
    }
  }
  // One capture at a time; each holds a renderer process.
  let queue = Promise.resolve();
  function snapshot(args) {
    const run = queue.then(() => capture(args || {}));
    queue = run.catch(() => {});
    return run;
  }
  return { register, handle, snapshot };
}

module.exports = { scheme, createHtmlCards, embedRequest, fromEmbed, isPageUrl };
