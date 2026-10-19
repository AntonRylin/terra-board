const { randomUUID } = require('node:crypto');

// Web cards (src/canvas/html-card.ts). HTML embed pages are served from
// terra-html://page/<token>/ so they never share the app's origin or its
// Content-Security-Policy; the board frames them with a sandbox that gives them
// an opaque origin. Browser frames load websites in their own persistent
// session (browser-frames.cjs). Pictures for the board are captured offscreen.
const scheme = 'terra-html';
const sourceLimit = 1000000;
const viewport = { min: 40, max: 4096 };
const browserChrome = 40;
const pageLimit = 64;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isPageUrl = (url) => typeof url === 'string' && url.startsWith(scheme + '://');

// The same picture key as src/canvas/html-card.ts (tests compare them).
function hash(value) {
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const clampSide = (value) => Math.round(Math.min(viewport.max, Math.max(viewport.min, value)));
const pageViewport = (o) => ({
  width: clampSide(o.width),
  height: clampSide(o.type === 'browser' ? o.height - browserChrome : o.height),
});
function snapshotKey(o) {
  const { width, height } = pageViewport(o);
  const source = o.type === 'browser' ? 'url:' + (o.url || '') : o.html || '';
  return `${width}x${height}-${hash(source)}`;
}

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

function createHtmlCards({ BrowserWindow, session, call, browserSession }) {
  const pages = new Map();
  function register(html) {
    if (typeof html !== 'string' || html.length > sourceLimit)
      throw Error('HTML embeds hold up to 1,000,000 characters.');
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

  const importPicture = async (image, name) =>
    (await call('importAsset', { name, bytes: image.toPNG() })).id;
  // Renders a page offscreen at a CSS size and imports its picture.
  async function captureWindow({ url, width, height, session, settle, timeout, browser }) {
    if (
      ![width, height].every((v) => Number.isInteger(v) && v >= viewport.min && v <= viewport.max)
    )
      throw Error('Invalid page size.');
    // Twice the CSS size for sharp zooming, within a 4096-pixel picture.
    const scale = Math.min(2, viewport.max / Math.max(width, height));
    const win = new BrowserWindow({
      show: false,
      frame: false,
      useContentSize: true,
      width,
      height,
      backgroundColor: '#ffffff',
      webPreferences: {
        // Pixel density rather than page zoom: Chromium remembers zoom per site,
        // which would carry over to browser frames in the same session.
        offscreen: { deviceScaleFactor: scale },
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        disableDialogs: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    const contents = win.webContents;
    let painted = null;
    contents.on('paint', (_event, _dirty, image) => {
      painted = image;
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Websites may redirect (to a sign-in page, say); embeds stay on their page.
    if (!browser) {
      contents.on('will-navigate', (event) => event.preventDefault());
      contents.on('will-frame-navigate', (event) => {
        if (!event.isMainFrame) event.preventDefault();
      });
    }
    contents.setAudioMuted(true);
    try {
      await Promise.race([contents.loadURL(url).catch(() => {}), delay(timeout)]);
      if (win.isDestroyed()) throw Error('The page could not be captured.');
      await delay(settle);
      contents.invalidate();
      await delay(50);
      let image = await contents.capturePage().catch(() => null);
      if (!image || image.isEmpty()) image = painted;
      if (!image || image.isEmpty()) throw Error('The page could not be captured.');
      // Window sizes round through the display scale; trim or fit to the exact picture.
      const target = { width: Math.round(width * scale), height: Math.round(height * scale) },
        size = image.getSize();
      if (size.width !== target.width || size.height !== target.height)
        image =
          size.width >= target.width && size.height >= target.height
            ? image.crop({ x: 0, y: 0, ...target })
            : image.resize({ ...target, quality: 'best' });
      return await importPicture(image, browser ? 'Web page.png' : 'HTML embed.png');
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }
  async function captureHtml({ html, width, height }) {
    const { token, url } = register(html);
    try {
      return await captureWindow({
        url,
        width,
        height,
        session: snapshotSession(),
        // Time after loading for fonts, scripts and entry animations to settle.
        settle: 700,
        timeout: 8000,
      });
    } finally {
      pages.delete(token);
    }
  }
  async function captureUrl({ url, width, height }) {
    let u;
    try {
      u = new URL(url);
    } catch {
      throw Error('Invalid address.');
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw Error('Invalid address.');
    return captureWindow({
      url: u.href,
      width,
      height,
      session: browserSession(),
      settle: 1500,
      timeout: 15000,
      browser: true,
    });
  }
  // A running browser frame, as it looks now.
  async function captureContents(contents) {
    const image = await Promise.race([contents.capturePage(), delay(5000).then(() => null)]);
    if (!image || image.isEmpty()) throw Error('The page could not be captured.');
    return importPicture(image, 'Web page.png');
  }
  // One capture at a time; each holds a renderer process.
  let queue = Promise.resolve();
  const serial = (job) => {
    const run = queue.then(job);
    queue = run.catch(() => {});
    return run;
  };
  return {
    register,
    handle,
    snapshot: (args) => serial(() => captureHtml(args || {})),
    snapshotUrl: (args) => serial(() => captureUrl(args || {})),
    captureContents,
  };
}

module.exports = {
  scheme,
  createHtmlCards,
  embedRequest,
  fromEmbed,
  isPageUrl,
  pageViewport,
  snapshotKey,
};
