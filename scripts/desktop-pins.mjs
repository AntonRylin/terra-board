// Pinned objects offer the board's commands: a right-click or the bar's More
// button opens a menu that duplicates the original into view, copies it for
// pasting, copies its text, finds it and unpins it, for pins of any board.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-pins-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Pins' });
const other = store.createBoard({ name: 'Elsewhere' });
const text = (id, x, y, value) => ({
  id,
  type: 'text',
  x,
  y,
  width: 300,
  height: 80,
  z: 1,
  text: value,
  fontSize: 44,
  color: '#29313b',
});
store.patchBoard({
  id: board.id,
  revision: 0,
  deleted: [],
  camera: { x: 0, y: 0, zoom: 1 },
  upserts: [
    text('text', 100, 100, 'vid 3'),
    { id: 'frame', type: 'frame', x: 100, y: 400, width: 300, height: 200, z: 0, text: 'Box' },
    { ...text('inside', 140, 460, 'inside'), z: 2 },
  ],
});
store.patchBoard({
  id: other.id,
  revision: 0,
  deleted: [],
  camera: { x: 0, y: 0, zoom: 1 },
  upserts: [text('far', 5000, 5000, 'from elsewhere')],
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
  [...(source ? [resolve('.')] : []), `--remote-debugging-port=${port}`],
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
const rect = (selector) =>
  read(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
  );
async function press(x, y, button = 'left') {
  const buttons = button === 'right' ? 2 : 1;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button,
    buttons,
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button,
    buttons: 0,
    clickCount: 1,
  });
}
async function click(selector, button = 'left') {
  const r = await until(() => rect(selector), selector);
  await press(r.x + r.width / 2, r.y + r.height / 2, button);
}
const key = async (key, code, modifiers = 0) => {
  const windowsVirtualKeyCode = code.startsWith('Key') ? code.charCodeAt(3) : 0;
  for (const type of ['keyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode });
};
const menuLabels = () =>
  read(
    `[...document.querySelectorAll('.context-menu')].map(m=>[...m.querySelectorAll('button,hr')].map(b=>b.tagName==='HR'?'-':b.textContent))`,
  );
const choose = (label) =>
  read(
    `(()=>{const b=[...document.querySelectorAll('.context-menu button')].find(b=>b.textContent===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`,
  );
const texts = async () =>
  (await read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`)).objects
    .filter((o) => o.type === 'text')
    .map((o) => ({ id: o.id, text: o.text, x: o.x, y: o.y }));
const pin = (id) => `.screen-pin[data-pin-key="${id}"]`;
const screenshot = async (name) =>
  writeFileSync(
    join(root, name),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
try {
  const target = await until(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (target) => target.type === 'page' && target.url.startsWith('canvas-app:'),
      );
    } catch {}
  }, 'app target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      message.error
        ? request?.reject(Error(message.error.message))
        : request?.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown')
      errors.push(message.params.exceptionDetails);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const ready = () =>
    read(
      `!!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading') && !document.getElementById('startup-screen')`,
    );
  await until(ready, 'canvas ready');
  // Pins live in this window's storage: one from this board, one from another.
  const pins = [
    { boardId: board.id, objectId: 'text', left: 900, top: 120, width: 300, height: 120 },
    { boardId: board.id, objectId: 'frame', left: 450, top: 420, width: 300, height: 234 },
    { boardId: other.id, objectId: 'far', left: 900, top: 520, width: 300, height: 120 },
  ];
  await read(`localStorage.setItem('terra-board.pins', ${JSON.stringify(JSON.stringify(pins))})`);
  await read('window.beforeReload = true');
  await send('Page.reload', { ignoreCache: true });
  await until(() => read('!window.beforeReload'), 'page reloaded');
  await until(ready, 'canvas ready after reload');
  const textPin = pin(`${board.id}/text`),
    framePin = pin(`${board.id}/frame`),
    otherPin = pin(`${other.id}/far`);
  await until(
    () => read(`document.querySelectorAll('.screen-pin canvas').length >= 3`),
    'pins drawn',
  );

  // A right-click on the pin opens its menu, not the board's.
  await click(textPin + ' .screen-pin-content', 'right');
  await until(async () => (await menuLabels()).length === 1, 'pin menu');
  assert.deepEqual((await menuLabels())[0], [
    'Duplicate here',
    'Copy',
    'Copy text',
    '-',
    'Show on its board',
    'Unpin from screen',
  ]);
  await screenshot('pin-menu.png');
  assert.equal(await choose('Duplicate here'), true);
  const copies = await until(async () => {
    const list = (await texts()).filter((o) => o.text === 'vid 3');
    return list.length === 2 && list;
  }, 'duplicate saved');
  const copy = copies.find((o) => o.id !== 'text');
  assert.notDeepEqual(
    [copy.x, copy.y],
    [128, 128],
    'the copy lands in view, not next to the original',
  );
  assert.deepEqual(
    await read(`[...document.querySelectorAll('.context-menu')].length`),
    0,
    'menu closed',
  );

  // A frame comes with what is inside it.
  await click(framePin + ' .screen-pin-content', 'right');
  await until(async () => (await menuLabels()).length === 1, 'frame pin menu');
  assert.ok(!(await menuLabels())[0].includes('Copy text'), 'no text item for a frame');
  await choose('Duplicate here');
  await until(
    async () => (await texts()).filter((o) => o.text === 'inside').length === 2,
    'frame contents duplicated',
  );

  // The More button works the same way, for a pin from another board.
  // A pin behind another still takes the first click on its buttons.
  await click(otherPin + ' [aria-label="More"]');
  await until(async () => (await menuLabels()).length === 1, 'more menu');
  await choose('Duplicate here');
  const far = await until(
    async () => (await texts()).find((o) => o.text === 'from elsewhere'),
    'other board object duplicated here',
  );
  assert.ok(far.x < 3000 && far.y < 3000, 'placed in view');
  // Its own board is untouched.
  const elsewhere = await read(
    `window.canvas.invoke('loadBoard',{id:${JSON.stringify(other.id)}})`,
  );
  assert.equal(elsewhere.objects.length, 1);

  // The bar's own duplicate button.
  await click(textPin + ' [aria-label="Duplicate here"]');
  await until(
    async () => (await texts()).filter((o) => o.text === 'vid 3').length === 3,
    'bar duplicate',
  );

  // Copy, then paste with Ctrl+V on the board.
  await click(textPin + ' .screen-pin-content', 'right');
  await until(async () => (await menuLabels()).length === 1, 'copy menu');
  await choose('Copy');
  await sleep(300);
  await click('.canvas-surface');
  await key('v', 'KeyV', 2);
  await until(
    async () => (await texts()).filter((o) => o.text === 'vid 3').length === 4,
    'copied pin pasted',
  );

  // Unpin from the menu.
  await click(otherPin + ' .screen-pin-content', 'right');
  await until(async () => (await menuLabels()).length === 1, 'unpin menu');
  await choose('Unpin from screen');
  await until(async () => !(await rect(otherPin)), 'unpinned');

  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: [
        'right-click menu',
        'duplicate into view',
        'frame contents',
        'more button',
        'other board',
        'bar duplicate',
        'copy and paste',
        'unpin',
      ],
      screenshot: join(root, 'pin-menu.png'),
    }),
  );
} catch (error) {
  console.error(error);
  if (socket) {
    try {
      await screenshot('failure.png');
      console.error(
        await read(
          `JSON.stringify({pins:document.querySelectorAll('.screen-pin').length,layer:JSON.stringify(document.querySelector('.screen-pins')?.getBoundingClientRect()),pictures:document.querySelectorAll('.screen-pin canvas').length,stored:localStorage.getItem('terra-board.pins')})`,
        ),
      );
    } catch {}
  }
  console.error('Library:', root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
