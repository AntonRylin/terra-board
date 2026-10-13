import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-frame-usages-'));
const store = new Store(root);
const sourceBoard = store.createBoard({ name: 'Process A board' });
const board = store.createBoard({ name: 'Workflow board' });
const other = store.createBoard({ name: 'Other processes' });
const trash = store.createBoard({ name: 'Deleted processes' });
const frame = (id, text, x, y, width = 700, height = 350, z = 0) => ({
  id,
  type: 'frame',
  text,
  x,
  y,
  width,
  height,
  z,
});
const sourceFrame = { ...frame('process-a', 'Process A', 0, 0, 300, 200), locked: true };
const link = (id, x, y) => ({
  ...frame(id, 'Old cached title', x, y, 140, 95, 5),
  frameLink: { boardId: sourceBoard.id, frameId: sourceFrame.id },
});
const same = link('same-board', 420, 40);
for (const [b, objects] of [
  [sourceBoard, [sourceFrame, same, frame('unused', 'Unused process', 0, 340, 300, 200)]],
  [
    board,
    [
      frame('process-b', 'Process B', 0, 0),
      link('b-1', 40, 50),
      link('b-2', 240, 50),
      link('b-3', 440, 50),
    ],
  ],
  [other, [frame('process-y', 'Process Y', 0, 0), link('y-1', 30, 40), link('unframed', 800, 0)]],
  [trash, [link('trashed', 0, 0)]],
])
  store.patchBoard({
    id: b.id,
    revision: 0,
    upserts: objects,
    deleted: [],
    camera: { x: 180, y: 180, zoom: 1 },
  });
store.updateBoard({ id: trash.id, patch: { trashed: true } });
store.setLastBoard({ id: sourceBoard.id });
store.close();
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const env = { ...process.env, CANVAS_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const source = !!process.env.TERRA_SOURCE_CHECK;
const harness = join(root, 'export-main.cjs');
if (source)
  writeFileSync(
    harness,
    `
const { dialog } = require('electron');
const path = require('node:path');
dialog.showSaveDialog = async (_win, options) => ({ canceled: false, filePath: path.join(process.env.CANVAS_DATA_DIR, options.defaultPath) });
require(${JSON.stringify(resolve('electron/main.cjs'))});
`,
  );
const child = spawn(
  source
    ? require('electron')
    : resolve(process.env.TERRA_TEST_EXE || 'release/win-unpacked/Terra Board.exe'),
  [...(source ? [harness] : []), `--remote-debugging-port=${port}`],
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
async function mouse(type, x, y, buttons = 0, modifiers = 0) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
    buttons,
    clickCount: 1,
    modifiers,
  });
}
async function click(selector) {
  let previous;
  const r = await until(async () => {
    const next = await rect(selector);
    const stable = next && JSON.stringify(next) === JSON.stringify(previous);
    previous = next;
    return stable ? next : null;
  }, selector);
  const x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, 1);
  await mouse('mouseReleased', x, y);
}
const key = async (key, code = key, modifiers = 0) => {
  const windowsVirtualKeyCode =
    { Tab: 9, Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, Delete: 46 }[key] ||
    key.toUpperCase().charCodeAt(0);
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    text: key === 'Enter' ? '\r' : undefined,
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
  });
};
const state = () => read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
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
        `!!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading')`,
      ),
    'canvas',
  );
  await until(
    () =>
      read(
        "!document.querySelector('#startup-screen') && !!document.querySelector('.canvas-toolbar')",
      ),
    'ready',
  );
  const boardState = (id) => read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(id)}})`);
  const rows = () =>
    read(
      "[...document.querySelectorAll('.frame-usages .content-search-result')].map(e=>({id:e.dataset.object,board:e.dataset.board,text:e.innerText}))",
    );
  const openUsages = async (boardId, x, y) => {
    const d = await boardState(boardId);
    const surface = await rect('.canvas-surface');
    const p = {
      x: surface.x + d.camera.x + x * d.camera.zoom,
      y: surface.y + d.camera.y + y * d.camera.zoom,
    };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...p,
      button: 'right',
      buttons: 2,
      clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...p,
      button: 'right',
      buttons: 0,
      clickCount: 1,
    });
    const enabled = await until(
      () =>
        read(
          "(()=>{const b=[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Find usages');return b&&!b.disabled})()",
        ),
      'Find usages action',
    );
    assert.equal(enabled, true);
    await read(
      "[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Find usages').click()",
    );
    await until(
      () => read("!!document.querySelector('.frame-usages [aria-busy=false]')"),
      'usages loaded',
    );
  };
  const filter = async (text) => {
    await click('[aria-label="Filter frame usages"]');
    await key('a', 'KeyA', 2);
    await send('Input.insertText', { text });
  };
  const assertSelected = async (id, boardId) => {
    await until(
      () => read('!!document.querySelector(\'[aria-label="Open original frame"]\')'),
      'linked instance selected',
    );
    await until(
      async () => (await read("window.canvas.invoke('library')")).lastBoard === boardId,
      'destination board',
    );
    await key('c', 'KeyC', 2);
    await until(
      async () => (await read('window.canvas.clipboardObjects()'))?.[0]?.id === id,
      'exact instance selected: ' + id,
    );
    const surface = await rect('.canvas-surface');
    await until(async () => {
      const d = await boardState(boardId),
        o = d.objects.find((o) => o.id === id);
      return (
        Math.abs(d.camera.x + (o.x + o.width / 2) * d.camera.zoom - surface.width / 2) < 1 &&
        Math.abs(d.camera.y + (o.y + o.height / 2) * d.camera.zoom - surface.height / 2) < 1
      );
    }, 'focused camera persisted');
  };
  const before = (await boardState(sourceBoard.id)).objects;
  await openUsages(sourceBoard.id, 150, 5);
  let matches = await rows();
  assert.equal(matches.length, 6);
  assert.equal(matches.filter((r) => r.text.startsWith('Process B')).length, 3);
  assert.equal(matches.filter((r) => r.text.startsWith('Process Y')).length, 1);
  assert.equal(matches.filter((r) => r.text.startsWith('On board canvas')).length, 2);
  assert.ok(matches.find((r) => r.id === 'b-3').text.includes('Occurrence 3 of 3'));
  assert.equal(
    await read("document.querySelector('[role=dialog]').getAttribute('aria-label')"),
    'Usages of Process A',
  );
  await screenshot('all-usages.png');
  await key('f', 'KeyF', 2);
  assert.equal(await read("document.querySelectorAll('[role=dialog]').length"), 1);
  await filter('Process B');
  assert.equal((await rows()).length, 3);
  await key('ArrowDown');
  await key('ArrowDown');
  assert.equal(await read('document.activeElement.dataset.object'), 'b-2');
  await key('Delete');
  assert.deepEqual((await boardState(sourceBoard.id)).objects, before);
  assert.equal(await read('document.activeElement.dataset.object'), 'b-2');
  await key('Enter');
  await assertSelected('b-2', board.id);
  // Searching from a link uses its original, including the current instance.
  await openUsages(board.id, 310, 95);
  assert.equal((await rows()).length, 6);
  assert.equal(
    await read("document.querySelector('[role=dialog]').getAttribute('aria-label')"),
    'Usages of Process A',
  );
  await filter('no matching process');
  assert.equal((await rows()).length, 0);
  assert.ok(await read("document.body.innerText.includes('No usages match this filter.')"));
  await filter('Process Y');
  await key('Enter');
  await assertSelected('y-1', other.id);
  // Click a result on this same board, then refresh after removing another occurrence.
  await openUsages(other.id, 90, 80);
  await click('[data-object="unframed"]');
  await assertSelected('unframed', other.id);
  await openUsages(other.id, 850, 40);
  await read(
    `window.canvas.invoke('patchBoard',{id:${JSON.stringify(board.id)},revision:1,upserts:[],deleted:['b-3']})`,
  );
  await read(
    "[...document.querySelectorAll('.frame-usages button')].find(e=>e.textContent==='Refresh').click()",
  );
  await until(async () => (await rows()).length === 5, 'updated occurrences');
  matches = await rows();
  assert.ok(matches.find((r) => r.id === 'b-2').text.includes('Occurrence 2 of 2'));
  await key('Escape');
  assert.equal(await read("!!document.querySelector('.frame-usages')"), false);
  await click('[aria-label="Open board Process A board"]');
  await until(
    async () => (await read("window.canvas.invoke('library')")).lastBoard === sourceBoard.id,
    'source board',
  );
  await openUsages(sourceBoard.id, 150, 345);
  assert.equal((await rows()).length, 0);
  assert.ok(
    await read("document.body.innerText.includes('This frame has no linked occurrences yet.')"),
  );
  assert.deepEqual((await boardState(sourceBoard.id)).objects, before);
  assert.deepEqual(errors, []);
  console.log(
    'FRAME_USAGES_DESKTOP_OK',
    JSON.stringify({
      root,
      checks: [
        'locked original context action',
        'six separate cross-board occurrences',
        'trash excluded',
        'process and board labels',
        'filter and empty states',
        'keyboard navigation',
        'exact cross-board and same-board instance focus',
        'original resolution from link',
        'refresh after deletion',
        'modal shortcut isolation',
      ],
      errors,
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
