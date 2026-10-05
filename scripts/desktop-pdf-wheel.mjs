// Real wheel input over the PDF overlay must zoom the board around the pointer.
// Run against a packaged build, optionally selected with CANVAS_EXECUTABLE.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { PDFDocument } from 'pdf-lib';

const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-pdf-wheel-'));
const store = new Store(root);
const pdf = await PDFDocument.create();
for (let i = 0; i < 4; i++) pdf.addPage().drawText(`Wheel zoom page ${i + 1}`);
const asset = await store.importAsset({ bytes: await pdf.save(), name: 'Wheel.pdf' });
const board = store.createBoard({ name: 'PDF wheel zoom' });
store.patchBoard({
  id: board.id,
  revision: 0,
  deleted: [],
  camera: { x: 0, y: 0, zoom: 1 },
  upserts: [
    {
      id: 'composer',
      type: 'frame',
      x: 380,
      y: 180,
      width: 680,
      height: 560,
      z: 1,
      text: 'PDF workspace',
      pdfComposer: {
        sources: [
          { id: 'source', assetId: asset.id, name: 'Wheel.pdf', kind: 'pdf', pageCount: 4 },
        ],
        columns: [
          {
            id: 'pages',
            name: 'Wheel.pdf',
            pages: Array.from({ length: 4 }, (_, i) => ({
              id: `page-${i}`,
              sourceId: 'source',
              pageIndex: i,
              rotation: 0,
            })),
          },
          { id: 'empty', name: 'Empty PDF', pages: [] },
        ],
      },
    },
  ],
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
const child = spawn(
  process.env.CANVAS_EXECUTABLE || resolve('release/win-unpacked/Terra Board.exe'),
  [`--remote-debugging-port=${port}`],
  { env, windowsHide: true, stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let launchError;
child.on('error', (error) => {
  launchError = error;
});
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw Error(`App exited: ${child.exitCode}`);
    const value = await fn();
    if (value) return value;
    await sleep(60);
  }
  throw Error(`Timed out: ${label}`);
}
let socket,
  sequence = 0;
const pending = new Map(),
  errors = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(`${method} timed out`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function read(expression) {
  const value = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (value.exceptionDetails) throw Error(value.exceptionDetails.text);
  return value.result.value;
}
const geometry = () =>
  read(`(() => {
  const e = document.querySelector('.canvas-pdf-composer'), r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, zoom: new DOMMatrix(getComputedStyle(e).transform).a,
    scroll: [...e.querySelectorAll('.pdf-composer-pages,.pdf-composer-columns')].map(n => [n.scrollLeft,n.scrollTop]) };
})()`);
async function zoom(selector, deltaY, modifiers = 0) {
  const point = await read(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)}), r = e.getBoundingClientRect();
    const x = r.x + Math.min(40,r.width/2), y = r.y + Math.min(30,r.height/2);
    const hit = document.elementFromPoint(x,y);
    return { x, y, hit: !!hit && (e === hit || e.contains(hit)) };
  })()`);
  assert.ok(point.hit, `pointer hits ${selector}`);
  const before = await geometry();
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: point.x,
    y: point.y,
    deltaX: 0,
    deltaY,
    modifiers,
  });
  const after = await until(
    async () => {
      const current = await geometry();
      return (
        (deltaY < 0 ? current.zoom > before.zoom * 1.05 : current.zoom < before.zoom * 0.95) &&
        current
      );
    },
    `canvas zoom ${deltaY < 0 ? 'in' : 'out'} over ${selector}`,
    4000,
  );
  for (const axis of ['x', 'y']) {
    assert.ok(
      Math.abs(
        (point[axis] - before[axis]) / before.zoom - (point[axis] - after[axis]) / after.zoom,
      ) < 1,
      `pointer anchor stays fixed on ${axis}`,
    );
  }
  assert.deepEqual(after.scroll, before.scroll, 'wheel does not scroll PDF contents');
  // Wait for the zoom animation to settle before sending the reverse input.
  let previous = after.zoom,
    stable = 0;
  await until(async () => {
    const current = (await geometry()).zoom;
    stable = Math.abs(current - previous) < 0.00001 ? stable + 1 : 0;
    previous = current;
    return stable >= 3;
  }, 'zoom settled');
}
try {
  const target = await until(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === 'page' && t.url.startsWith('canvas-app:'),
      );
    } catch {}
  }, 'renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      message.error
        ? request.reject(Error(message.error.message))
        : request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown')
      errors.push(message.params.exceptionDetails);
  });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await until(
    () =>
      read(
        `!!document.querySelector('.pdf-composer-page canvas') && !document.querySelector('.canvas-loading') && !document.getElementById('startup-screen')`,
      ),
    'PDF ready',
  );
  for (const selector of [
    '.pdf-composer-page',
    '.pdf-composer-column-header',
    '[data-column-id="empty"] .pdf-composer-pages',
    '.pdf-composer-header',
  ]) {
    await zoom(selector, -100);
    await zoom(selector, 100);
  }
  await read(`document.querySelector('.pdf-composer-page').click()`);
  await zoom('.pdf-composer-page', -100, 2);
  await zoom('.pdf-composer-page', 100, 2);
  assert.deepEqual(errors, [], 'no renderer exceptions');
  console.log('PDF_WHEEL_DESKTOP_OK', JSON.stringify({ root, cases: 10 }));
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  socket?.close();
  child.kill();
}
