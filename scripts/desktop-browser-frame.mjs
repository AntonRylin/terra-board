// Browser frames in the desktop app: a website shows as a captured picture, a
// double-click runs it in its own session over the board, navigation updates
// the frame like a browser tab, and stopping captures how it looks now. Pages
// come from a local test server. TERRA_SOURCE_CHECK=1 runs the built source.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { snapshotKey } from '../src/canvas/html-card.ts';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');

const site = http.createServer((req, res) => {
  const page = (title, color, body) =>
    `<!doctype html><title>${title}</title><body style="margin:0;height:100vh;background:${color};font:28px sans-serif">${body}</body>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (req.url.startsWith('/b'))
    res.end(
      page(
        'Page B',
        '#16a34a',
        '<p id="cookie"></p><script>document.getElementById("cookie").textContent = document.cookie</script>',
      ),
    );
  else
    res.end(
      page(
        'Page A',
        '#e11d48',
        '<a id="next" href="/b">Next page</a><script>document.cookie = "seen=1; max-age=3600"</script>',
      ),
    );
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${site.address().port}`;

mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-browser-frame-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Browser frames' });
store.patchBoard({
  id: board.id,
  revision: 0,
  upserts: [
    {
      id: 'tab',
      type: 'browser',
      x: 100,
      y: 120,
      width: 720,
      height: 480,
      z: 1,
      url: origin + '/a',
      text: '',
    },
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
async function until(fn, label, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
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
async function read(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
const frame = async () =>
  (await read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`)).objects.find(
    (o) => o.id === 'tab',
  );
const screenshot = async (name) =>
  writeFileSync(
    join(root, name),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
const cardCenter = () =>
  read(`(async()=>{
    const d = await window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}});
    const o = d.objects.find((o) => o.id === 'tab'), c = d.camera;
    const r = document.querySelector('.canvas-surface').getBoundingClientRect();
    return { x: r.left + (o.x + o.width / 2) * c.zoom + c.x, y: r.top + (o.y + o.height / 2) * c.zoom + c.y };
  })()`);
// The website is its own target: evaluate there.
async function pageRead(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === 'webview' && t.url.startsWith(origin));
  if (!target) return null;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
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
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
    return (await reply).result?.result?.value ?? null;
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

  // 1. A new frame gets a picture of its page, captured offscreen below the address bar.
  const first = await until(async () => {
    const o = await frame();
    return o.assetId && o.snapshotKey === snapshotKey(o) ? o : null;
  }, 'first picture');
  assert.deepEqual(await read(`window.canvas.assetDimensions(${JSON.stringify(first.assetId)})`), {
    width: 1440,
    height: 880,
  });
  await sleep(400);
  await screenshot('1-picture.png');

  // 2. A double-click opens the website, isolated from the app.
  const center = await cardCenter();
  await clickAt(center.x, center.y, 2);
  await until(() => read(`!!document.querySelector('.board-browser-live webview')`), 'live frame');
  assert.equal(await until(() => pageRead(`document.title`), 'page'), 'Page A');
  assert.deepEqual(
    await pageRead(
      `({ require: typeof require, bridge: typeof window.canvas, agent: /Electron|terra/i.test(navigator.userAgent), width: innerWidth, height: innerHeight })`,
    ),
    { require: 'undefined', bridge: 'undefined', agent: false, width: 720, height: 440 },
  );
  await screenshot('2-live.png');

  // 3. Following a link updates the frame like a tab: address and title.
  await pageRead(`document.getElementById('next').click()`);
  await until(async () => {
    const o = await frame();
    return o.url === origin + '/b' && o.text === 'Page B';
  }, 'navigation saved');
  assert.equal(await pageRead(`document.getElementById('cookie').textContent`), 'seen=1');
  assert.equal(
    await read(`document.querySelector('.browser-frame-bar input').value`),
    origin + '/b',
  );

  // 4. The address bar and Back work.
  await read(`(()=>{
    const input = document.querySelector('.browser-frame-bar input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, '127.0.0.1:${new URL(origin).port}/a?typed=1');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
  })()`);
  await until(async () => (await frame()).url === origin + '/a?typed=1', 'typed address');
  await until(
    () => read(`!document.querySelector('.browser-frame-bar [aria-label="Back"]').disabled`),
    'back enabled',
  );
  await click('.browser-frame-bar [aria-label="Back"]');
  await until(async () => (await frame()).url === origin + '/b', 'back');
  await sleep(300);
  await screenshot('3-navigated.png');

  // 5. Clicking the board stops the page and keeps a picture of it as it is now.
  await clickAt(center.x + 600, center.y + 300);
  await until(() => read(`!document.querySelector('.board-browser-live')`), 'live stops');
  const last = await until(async () => {
    const o = await frame();
    return o.assetId !== first.assetId && o.snapshotKey === snapshotKey(o) ? o : null;
  }, 'live picture');
  assert.equal(last.url, origin + '/b');
  await sleep(400);
  await screenshot('4-stopped.png');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ root, first: first.assetId, last: last.assetId }, null, 2));
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
  site.close();
}
