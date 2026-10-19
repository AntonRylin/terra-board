// HTML embeds in the desktop app: the board shows a captured picture, a
// double-click runs the page sandboxed over the board, and code edits capture a
// new picture. TERRA_SOURCE_CHECK=1 runs the built source instead of the package.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { htmlSnapshotKey } from '../src/canvas/html-card.ts';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');

const page = `<!doctype html><html><head><style>
body{margin:0;height:100vh;display:grid;place-items:center;background:#2f6fed;font:24px sans-serif}
#count{font:inherit;padding:16px 28px}
</style></head><body><button id="count">0</button><script>
const b = document.getElementById('count');
b.onclick = () => { b.textContent = String(+b.textContent + 1); };
const facts = {
  bridge: typeof window.canvas,
  width: innerWidth,
  height: innerHeight,
  parent: (() => { try { return String(!!parent.document); } catch { return 'blocked'; } })(),
  storage: (() => { try { localStorage.length; return 'open'; } catch { return 'blocked'; } })(),
};
fetch('canvas-media://asset/${'a'.repeat(64)}/preview')
  .then(() => 'open', () => 'blocked')
  .then((media) => { document.body.dataset.facts = JSON.stringify({ ...facts, media }); });
</script></body></html>`;

mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-html-embed-'));
const store = new Store(root);
const board = store.createBoard({ name: 'HTML embeds' });
store.patchBoard({
  id: board.id,
  revision: 0,
  upserts: [
    { id: 'embed', type: 'html', x: 100, y: 120, width: 480, height: 320, z: 1, html: page },
  ],
  camera: { x: 0, y: 0, zoom: 1 },
});
store.setLastBoard({ id: board.id });
store.close();

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const env = { ...process.env, CANVAS_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const source = !!process.env.TERRA_SOURCE_CHECK;
const child = spawn(
  source
    ? require('electron')
    : resolve(process.env.TERRA_TEST_EXE || 'release/win-unpacked/Terra Board.exe'),
  [
    ...(source ? [resolve('.')] : []),
    `--remote-debugging-port=${port}`,
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
  { env, windowsHide: true, stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(80);
  }
  throw Error('Timed out: ' + label);
}
let socket,
  seq = 0;
const pending = new Map(),
  errors = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(method + ' timed out'));
    }, 15000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject,
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function read(expression, contextId) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...(contextId ? { contextId } : {}),
  });
  if (r.exceptionDetails)
    throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const rect = (selector) =>
  read(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
  );
async function mouse(type, x, y, buttons = 0, clickCount = 1) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
    buttons,
    clickCount,
  });
}
async function clickAt(x, y, count = 1) {
  await mouse('mouseMoved', x, y);
  for (let c = 1; c <= count; c++) {
    await mouse('mousePressed', x, y, 1, c);
    await mouse('mouseReleased', x, y, 0, c);
  }
}
async function click(selector) {
  const r = await until(() => rect(selector), selector);
  await clickAt(r.x + r.width / 2, r.y + r.height / 2);
}
const key = async (key, code = key, modifiers = 0, windowsVirtualKeyCode) => {
  for (const type of ['keyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode });
};
const state = () => read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
const embed = async () => (await state()).objects.find((o) => o.id === 'embed');
const screenshot = async (name) =>
  writeFileSync(
    join(root, name),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
// The card's center on screen, from the board camera and the canvas position.
const cardCenter = () =>
  read(`(async()=>{
    const d = await window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}});
    const o = d.objects.find((o) => o.id === 'embed'), c = d.camera;
    const r = document.querySelector('.canvas-surface').getBoundingClientRect();
    return { x: r.left + (o.x + o.width / 2) * c.zoom + c.x, y: r.top + (o.y + o.height / 2) * c.zoom + c.y };
  })()`);
// The running page is out of process (its own origin): evaluate in its target.
async function frameRead(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const frame = targets.find((t) => t.url.startsWith('terra-html://'));
  if (!frame) return null;
  const ws = new WebSocket(frame.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  try {
    const reply = new Promise((r) =>
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id === 1) r(m);
      }),
    );
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
      }),
    );
    const m = await reply;
    return m.result?.result?.value ?? null;
  } finally {
    ws.close();
  }
}
try {
  const target = await until(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === 'page' && t.url.startsWith('canvas-app:'),
      );
    } catch {}
  }, 'app target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p?.reject(Error(m.error.message)) : p?.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown')
      errors.push(
        m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text,
      );
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await until(
    () =>
      read(
        `!!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading')`,
      ),
    'canvas',
  );

  // 1. Opening the board captures a picture at twice the card's CSS size.
  const captured = await until(async () => {
    const o = await embed();
    return o.assetId && o.htmlSnapshotKey ? o : null;
  }, 'first picture');
  assert.equal(captured.htmlSnapshotKey, htmlSnapshotKey(captured));
  assert.deepEqual(
    await read(`window.canvas.assetDimensions(${JSON.stringify(captured.assetId)})`),
    {
      width: 960,
      height: 640,
    },
  );
  await sleep(500);
  await screenshot('1-picture.png');

  // 2. A double-click runs the page over the board, sandboxed.
  const center = await cardCenter();
  await clickAt(center.x, center.y, 2);
  await until(
    () => read(`!!document.querySelector('.board-html-live iframe[src^="terra-html://"]')`),
    'live frame',
  );
  const facts = JSON.parse(
    await until(() => frameRead(`document.body.dataset.facts || ''`), 'page facts'),
  );
  assert.deepEqual(facts, {
    bridge: 'undefined',
    width: 480,
    height: 320,
    parent: 'blocked',
    storage: 'blocked',
    media: 'blocked',
  });
  await clickAt(center.x, center.y);
  await clickAt(center.x, center.y);
  await until(
    async () => (await frameRead(`document.getElementById('count').textContent`)) === '2',
    'clicks reach the page',
  );
  await screenshot('2-live.png');

  // 3. Editing the code saves it and captures a new picture.
  await click('.selection-tools [aria-label="Edit code"]');
  await until(() => read(`!document.querySelector('.board-html-live')`), 'live stops for editing');
  await until(() => read(`!!document.querySelector('.html-editor textarea')`), 'editor');
  await until(
    () => read(`!!document.querySelector('.html-editor-preview iframe[src^="terra-html://"]')`),
    'editor preview',
  );
  await read(`(()=>{
    const t = document.querySelector('.html-editor textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(t, t.value.replace('#2f6fed', '#16a34a'));
    t.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(600);
  await screenshot('3-editor.png');
  await click('.html-editor .button.primary');
  await until(() => read(`!document.querySelector('.html-editor')`), 'editor closes');
  const edited = await until(async () => {
    const o = await embed();
    return o.html.includes('#16a34a') &&
      o.assetId !== captured.assetId &&
      htmlSnapshotKey(o) === o.htmlSnapshotKey
      ? o
      : null;
  }, 'edited picture');
  await sleep(500);
  await screenshot('4-edited.png');

  // 4. Undo restores the earlier code with its own picture, without a capture.
  await click('.canvas-surface canvas');
  await key('z', 'KeyZ', 2, 90);
  const undone = await until(async () => {
    const o = await embed();
    return o.html.includes('#2f6fed') ? o : null;
  }, 'undo');
  assert.equal(undone.assetId, captured.assetId);
  assert.equal(undone.htmlSnapshotKey, captured.htmlSnapshotKey);

  // 5. Clicking the board stops a running page.
  await clickAt(center.x, center.y, 2);
  await until(() => read(`!!document.querySelector('.board-html-live')`), 'live again');
  await clickAt(center.x + 400, center.y + 300);
  await until(() => read(`!document.querySelector('.board-html-live')`), 'live stops');

  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ root, picture: captured.assetId, edited: edited.assetId, facts }, null, 2),
  );
} catch (error) {
  console.error(error);
  if (socket) {
    try {
      await screenshot('failure.png');
    } catch {}
  }
  console.error('Library:', root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
