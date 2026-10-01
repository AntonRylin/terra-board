// A click-through decoration around the native Windows frame. Keep the main
// window opaque and normally resizable; its content needs no transparent gutter.
const padding = 56;
const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Local Canvas shadow</title><style>
html,body { margin:0; width:100%; height:100%; overflow:hidden; background:transparent; }
div { position:absolute; inset:${padding}px; border-radius:8px;
  box-shadow:0 12px 36px rgba(15,23,35,.13),0 3px 10px rgba(15,23,35,.08); }
</style></head><body><div></div></body></html>`;

function attachWindowShadow(owner, { BrowserWindow }, platform = process.platform) {
  if (platform !== 'win32') return null;
  const shadow = new BrowserWindow({
    parent: owner,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Local Canvas shadow',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      backgroundThrottling: false,
    },
  });
  shadow.setIgnoreMouseEvents(true);
  shadow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  shadow.webContents.on('will-navigate', (event) => event.preventDefault());
  let ready = false;
  const sync = () => {
    if (owner.isDestroyed() || shadow.isDestroyed()) return;
    if (
      !ready ||
      !owner.isVisible() ||
      owner.isMinimized() ||
      owner.isMaximized() ||
      owner.isFullScreen() ||
      owner.isSnapped()
    ) {
      shadow.hide();
      return;
    }
    const bounds = owner.getBounds();
    const content = owner.getContentBounds();
    // Windows includes invisible resize borders on the left, right and bottom
    // in getBounds(). The title bar's top edge already matches the visible frame.
    const inset = Math.max(0, Math.min(12, content.x - bounds.x - 1));
    const next = {
      x: bounds.x + inset - padding,
      y: bounds.y - padding,
      width: bounds.width - inset * 2 + padding * 2,
      height: bounds.height - inset + padding * 2,
    };
    const current = shadow.getBounds();
    if (Object.keys(next).some((key) => next[key] !== current[key])) shadow.setBounds(next);
    shadow.setOpacity(owner.isFocused() ? 1 : 0.7);
    if (!shadow.isVisible()) shadow.showInactive();
  };
  const events = [
    'show',
    'hide',
    'move',
    'resize',
    'resized',
    'maximize',
    'unmaximize',
    'minimize',
    'restore',
    'enter-full-screen',
    'leave-full-screen',
    'focus',
    'blur',
  ];
  const dispose = () => {
    for (const event of events) owner.removeListener(event, sync);
    owner.removeListener('closed', dispose);
    if (!shadow.isDestroyed()) shadow.destroy();
  };
  for (const event of events) owner.on(event, sync);
  owner.once('closed', dispose);
  shadow.once('closed', dispose);
  shadow.once('ready-to-show', () => {
    ready = true;
    sync();
  });
  shadow.webContents.once('render-process-gone', dispose);
  shadow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(dispose);
  return shadow;
}
module.exports = { attachWindowShadow };
