// Packaged-app check for Board history: delete a text box, open History with
// Ctrl+H, restore it from the Deleted tab, and undo/redo the restore.
// TERRA_TEST_EXE picks the executable (default release/win-unpacked).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-board-history-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Strategic' });
const list = {
  id: 'goals',
  type: 'text',
  x: 0,
  y: 0,
  width: 320,
  height: 110,
  z: 1,
  text: '1. Инвестировать правильно деньги\n2. Получить ВНЖ и ПМЖ',
  color: '#29313b',
  fontSize: 28,
  textBox: true,
};
store.patchBoard({
  id: board.id,
  revision: 0,
  upserts: [list, { ...list, id: 'keep', y: 300, text: 'Keep me', z: 2 }],
  deleted: [],
  camera: { x: 200, y: 200, zoom: 1 },
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
  resolve(process.env.TERRA_TEST_EXE || 'release/win-unpacked/Terra Board.exe'),
  [`--remote-debugging-port=${port}`],
  { env, windowsHide: true, stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(60);
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
async function mouse(type, x, y, buttons = 0, button = 'left') {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' && !buttons ? 'none' : button,
    buttons,
    clickCount: 1,
  });
}
async function clickAt(x, y, button = 'left') {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, button === 'left' ? 1 : 2, button);
  await mouse('mouseReleased', x, y, 0, button);
}
// Clicks the first element matching the selector whose text includes `text`.
async function click(selector, text = '') {
  const r = await until(
    () =>
      read(
        `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.innerText.includes(${JSON.stringify(text)}));if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      ),
    `${selector} ${text}`,
  );
  await clickAt(r.x, r.y);
}
const key = async (key, code, modifiers = 0, windowsVirtualKeyCode = 0) => {
  for (const type of ['keyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode });
};
const state = () => read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
const texts = async () =>
  (await state()).objects
    .map((o) => o.id)
    .sort()
    .join(',');
const screenshot = async (name) =>
  writeFileSync(
    join(root, name),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
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
        "!document.querySelector('#startup-screen') && !!document.querySelector('.canvas-toolbar') && !!document.querySelector('.canvas-surface canvas')",
      ),
    'ready',
  );
  await sleep(500);
  const surface = await read(
    "(()=>{const r=document.querySelector('.canvas-surface').getBoundingClientRect();return {x:r.x,y:r.y}})()",
  );
  const d = await state();
  const at = (x, y) => ({
    x: surface.x + d.camera.x + x * d.camera.zoom,
    y: surface.y + d.camera.y + y * d.camera.zoom,
  });

  // 1. Select the list and delete it with the Delete key.
  const center = at(list.width / 2, list.height / 2);
  await clickAt(center.x, center.y);
  await until(
    () => read("!!document.querySelector('.selection-toolbar-content')"),
    'list selected',
  );
  await key('Delete', 'Delete', 0, 46);
  await until(async () => (await texts()) === 'keep', 'list deleted and saved');

  // 2. The canvas menu offers Board history.
  const empty = at(800, -100);
  await clickAt(empty.x, empty.y, 'right');
  await until(
    () =>
      read(
        "[...document.querySelectorAll('.context-menu button')].some(b=>b.innerText.includes('Board history'))",
      ),
    'context menu entry',
  );
  await key('Escape', 'Escape', 0, 27);

  // 3. Ctrl+H opens History with the deletion first.
  await key('h', 'KeyH', 2, 72);
  await until(() => read("!!document.querySelector('.board-history-row')"), 'history rows');
  const rows = await read(
    "[...document.querySelectorAll('.board-history-row')].map(r=>r.innerText.replace(/\\s+/g,' '))",
  );
  assert.match(rows[0], /Deleted · Text/);
  assert.match(rows[0], /Инвестировать правильно деньги/);
  assert.ok(
    rows.some((r) => /Added · Text/.test(r)),
    'creation is listed',
  );
  await screenshot('history-all.png');

  // 4. Deleted tab, then Restore.
  await click('.board-history-filter button', 'Deleted');
  await until(
    async () => (await read("document.querySelectorAll('.board-history-row').length")) === 1,
    'only the deleted list',
  );
  await screenshot('history-deleted.png');
  await click('.board-history-row .board-history-action', 'Restore');
  await until(
    () => read("document.querySelector('.board-history-notice')?.innerText.includes('restored')"),
    'restore notice',
  );
  await until(async () => (await texts()) === 'goals,keep', 'list restored and saved');
  const restored = (await state()).objects.find((o) => o.id === 'goals');
  assert.equal(restored.text, list.text);
  assert.equal(restored.x, list.x);
  await screenshot('history-restored.png');

  // 5. Restore is an ordinary edit: Ctrl+Z removes it again, Ctrl+Shift+Z brings it back.
  await key('Escape', 'Escape', 0, 27);
  await until(() => read("!document.querySelector('.board-history')"), 'history closed');
  await key('z', 'KeyZ', 2, 90);
  await until(async () => (await texts()) === 'keep', 'undo restore');
  await key('z', 'KeyZ', 2 | 8, 90);
  await until(async () => (await texts()) === 'goals,keep', 'redo restore');

  // 6. History now shows the restore as an addition, and Deleted is empty.
  await key('h', 'KeyH', 2, 72);
  await until(() => read("!!document.querySelector('.board-history-row')"), 'history reopened');
  await sleep(300);
  await click('.board-history-filter button', 'Deleted');
  await until(
    () =>
      read("document.querySelector('.board-history-list')?.innerText.includes('Nothing deleted')"),
    'deleted tab empty',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      root,
      checks: [
        'delete key removes and saves',
        'context menu entry',
        'Ctrl+H opens history',
        'deletion listed with text',
        'Deleted tab',
        'restore puts list back unchanged',
        'undo and redo of restore',
        'Deleted tab empty after restore',
      ],
    }),
  );
} catch (error) {
  console.error(error);
  if (socket) {
    try {
      await screenshot('failure.png');
      console.error(await read('document.body.innerText'));
    } catch {}
  }
  console.error('Library:', root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
