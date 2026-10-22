// The mouse wheel over tables and lists zooms the board under the pointer, as
// it does over the bare canvas. TERRA_TEST_EXE picks the packaged app;
// TERRA_SOURCE_CHECK=1 runs the built source instead.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');

mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-overlay-wheel-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Wheel over overlays' });
store.patchBoard({
  id: board.id,
  revision: 0,
  upserts: [
    {
      id: 'table',
      type: 'table',
      x: 100,
      y: 100,
      width: 420,
      height: 260,
      z: 1,
      text: 'Words',
      table: {
        columns: [
          { id: 'w', name: 'Word', type: 'text', width: 180 },
          { id: 'm', name: 'Meaning', type: 'text', width: 220 },
        ],
        rows: [
          { id: 'r1', cells: { w: 'el pan', m: 'bread' } },
          { id: 'r2', cells: { w: 'la sal', m: 'salt' } },
        ],
      },
    },
    {
      id: 'list',
      type: 'list',
      x: 600,
      y: 100,
      width: 320,
      height: 188,
      z: 2,
      text: 'List',
      items: [
        { id: 'a', text: 'First item', checked: false },
        { id: 'b', text: 'Second item', checked: false },
      ],
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
// What is under a point, so the wheel really lands on the overlay.
const hit = (x, y) =>
  read(
    `(()=>{const e=document.elementFromPoint(${x},${y});return e?e.closest('[data-table-id],[data-list-id]')?.className||e.tagName:null})()`,
  );
const zoom = () => read(`document.querySelector('.zoom-value')?.textContent`);
async function wheelZooms(selector, label) {
  const box = await until(() => rect(selector), selector);
  const at = { x: box.x + 40, y: box.y + box.height - 30 };
  assert.match(
    String(await hit(at.x, at.y)),
    /canvas-(table|list)/,
    `${label} is under the pointer`,
  );
  const before = await zoom();
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'none' });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: at.x,
    y: at.y,
    deltaX: 0,
    deltaY: -100,
  });
  await until(
    async () => (await zoom()) !== before,
    `wheel over the ${label} zooms the board`,
    3000,
  );
  // Let the eased zoom settle before the next check.
  await sleep(800);
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
  await until(() => rect('[data-table-id="table"]'), 'table on the board', 40000);
  await sleep(500);

  await wheelZooms('[data-table-id="table"]', 'table');
  await wheelZooms('[data-list-id="list"]', 'list');

  assert.deepEqual(errors, []);
  console.log('Wheel over tables and lists zooms the board.');
} catch (error) {
  console.error(error);
  console.error('Library:', root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
