import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-stacking-'));
const store = new Store(root);
const hierarchyCheck = !!process.env.TERRA_HIERARCHY_CHECK;
const frameCheck = !!process.env.TERRA_FRAME_CHECK || hierarchyCheck;
const board = store.createBoard({ name: 'Stacking' });
store.setLastBoard({ id: board.id });
const list = (id, x, y, z) => ({
  id,
  type: 'list',
  text: id,
  x,
  y,
  width: 320,
  height: 184,
  z,
  items: [{ id: id + '-item', text: 'An item', checked: false }],
});
const frameObjects = [
  {
    id: 'frame',
    type: 'frame',
    text: 'Frame with contents',
    x: 180,
    y: 180,
    width: 420,
    height: 400,
    z: 8,
  },
  { id: 'red', type: 'rect', x: 230, y: 260, width: 60, height: 100, z: 2, color: '#e02030' },
  { id: 'nested', type: 'frame', text: 'Nested', x: 310, y: 240, width: 160, height: 200, z: 3 },
  {
    id: 'label',
    type: 'text',
    text: 'Keep me inside',
    textBox: true,
    x: 330,
    y: 300,
    width: 120,
    height: 40,
    z: 4,
    fontSize: 16,
  },
  {
    id: 'peer',
    type: 'frame',
    text: 'Overlapping frame',
    x: 520,
    y: 300,
    width: 240,
    height: 350,
    z: 10,
  },
  {
    id: 'ordinary',
    type: 'frame',
    text: 'Only my contents',
    x: 850,
    y: 200,
    width: 300,
    height: 350,
    z: 5,
  },
  {
    id: 'ordinary-note',
    type: 'rect',
    x: 900,
    y: 260,
    width: 100,
    height: 100,
    z: 6,
    color: '#20b060',
  },
];
const hierarchyObjects = [
  { id: 'a', type: 'frame', text: 'Frame A', x: 180, y: 180, width: 460, height: 420, z: 1 },
  { id: 'solo', type: 'rect', x: 230, y: 260, width: 80, height: 80, z: 2, color: '#20b060' },
  { id: 'local', type: 'rect', x: 540, y: 340, width: 60, height: 80, z: 3, color: '#e02030' },
  { id: 'sibling', type: 'rect', x: 550, y: 350, width: 60, height: 80, z: 4, color: '#3050e0' },
  { id: 'covered', type: 'rect', x: 540, y: 480, width: 60, height: 70, z: 5, color: '#a046d0' },
  { id: 'b', type: 'frame', text: 'Frame B', x: 520, y: 300, width: 300, height: 350, z: 6 },
  { id: 'foreign', type: 'rect', x: 570, y: 380, width: 60, height: 80, z: 7, color: '#e0b020' },
  {
    id: 'foreign-covered',
    type: 'rect',
    x: 550,
    y: 490,
    width: 60,
    height: 60,
    z: 8,
    color: '#a04620',
  },
];
store.patchBoard({
  id: board.id,
  revision: 0,
  upserts: hierarchyCheck
    ? hierarchyObjects
    : frameCheck
      ? frameObjects
      : [
          list('back', 200, 200, 1),
          list('middle', 280, 260, 2),
          list('front', 360, 320, 3),
          list('alone', 780, 200, 4),
        ],
  camera: { x: 0, y: 0, zoom: 1 },
});
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
async function click(selector) {
  const r = await until(() => rect(selector), selector);
  const x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, 1);
  await mouse('mouseReleased', x, y);
}
const key = async (key, code = key, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
};
const state = () => read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
const screenshot = async (name) =>
  writeFileSync(
    join(root, name),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
const topListAt = (x, y) =>
  read(`document.elementFromPoint(${x},${y})?.closest('[data-list-id]')?.dataset.listId`);
async function selectBack() {
  const r = await rect('[data-list-id="back"]');
  await mouse('mousePressed', r.x + 24, r.y + 20, 1);
  await mouse('mouseReleased', r.x + 24, r.y + 20);
  await until(
    () => read(`document.querySelector('[data-list-id="back"]').dataset.selected==='true'`),
    'back selected',
  );
}
async function frameChecks() {
  const canvas = await rect('.canvas-surface');
  const worldClick = async (x, y) => {
    await mouse('mousePressed', canvas.x + x, canvas.y + y, 1);
    await mouse('mouseReleased', canvas.x + x, canvas.y + y);
    await until(
      () =>
        read(
          `!!document.querySelector('[aria-label="Export selected"]') && getComputedStyle(document.querySelector('.selection-tools')).visibility==='visible'`,
        ),
      'frame selected',
    );
  };
  await worldClick(852, 380);
  assert.equal(
    await rect('[aria-label="Bring to front"]'),
    null,
    'a frame with contents alone must not show the button',
  );
  await worldClick(182, 460);
  assert.ok(await rect('[aria-label="Bring to front"]'), 'overlapping peer frames offer ordering');
  await screenshot('frames-before.png');
  await click('[aria-label="Bring to front"]');
  const moved = ['frame', 'red', 'nested', 'label'];
  const reordered = await until(async () => {
    const objects = (await state()).objects;
    return objects.filter((o) => moved.includes(o.id)).every((o) => o.z > 10) && objects;
  }, 'frame and all contents raised together');
  const byId = new Map(reordered.map((o) => [o.id, o]));
  assert.ok(byId.get('frame').z < byId.get('red').z);
  assert.ok(byId.get('frame').z < byId.get('nested').z);
  assert.ok(byId.get('nested').z < byId.get('label').z);
  for (const original of frameObjects) {
    const current = byId.get(original.id);
    for (const field of ['x', 'y', 'width', 'height'])
      assert.equal(current[field], original[field]);
    if (!moved.includes(original.id)) assert.equal(current.z, original.z);
  }
  await screenshot('frames-after.png');
  await key('z', 'KeyZ', 2);
  await until(async () => {
    const objects = (await state()).objects;
    return frameObjects.every((o) => objects.find((p) => p.id === o.id).z === o.z);
  }, 'undo restores the entire frame bundle');
  await key('z', 'KeyZ', 10);
  await until(async () => {
    const objects = (await state()).objects;
    return reordered.every((o) => objects.find((p) => p.id === o.id).z === o.z);
  }, 'redo restores the entire frame bundle');
  // Move the raised frame clear of its peer; every contained item must still follow.
  const start = { x: canvas.x + 182, y: canvas.y + 460 };
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...start,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    modifiers: 1,
  });
  for (let step = 1; step <= 10; step++)
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x - (140 * step) / 10,
      y: start.y,
      button: 'left',
      buttons: 1,
      modifiers: 1,
    });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: start.x - 140,
    y: start.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    modifiers: 1,
  });
  const dragged = await until(async () => {
    const objects = (await state()).objects;
    return Math.abs(objects.find((o) => o.id === 'frame').x - 40) < 0.01 && objects;
  }, 'raised frame moved');
  for (const id of moved) {
    const current = dragged.find((o) => o.id === id),
      original = frameObjects.find((o) => o.id === id);
    assert.ok(Math.abs(current.x - (original.x - 140)) < 0.01, `${id} follows the frame`);
    assert.equal(current.y, original.y);
  }
  await until(
    async () => !(await rect('[aria-label="Bring to front"]')),
    'button disappears after frames no longer overlap',
  );
  await send('Page.reload');
  await until(
    () =>
      read(
        `!!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading') && !document.querySelector('#startup-screen')`,
      ),
    'reloaded frames',
  );
  const reloaded = (await state()).objects;
  for (const current of dragged) {
    const saved = reloaded.find((o) => o.id === current.id);
    assert.equal(saved.z, current.z);
    assert.equal(saved.x, current.x);
  }
}
async function hierarchyChecks() {
  const canvas = await rect('.canvas-surface');
  const at = async (x, y) => {
    await mouse('mousePressed', canvas.x + x, canvas.y + y, 1);
    await mouse('mouseReleased', canvas.x + x, canvas.y + y);
    await until(
      () =>
        read(
          `!!document.querySelector('.selection-tools') && getComputedStyle(document.querySelector('.selection-tools')).visibility==='visible'`,
        ),
      'item selected',
    );
    await read(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`,
    );
  };
  await at(250, 280);
  assert.equal(
    await rect('[aria-label="Bring to front"]'),
    null,
    'a lone item ignores its containing frame',
  );
  await at(545, 485);
  assert.equal(
    await rect('[aria-label="Bring to front"]'),
    null,
    'an item ignores overlapping foreign frames and their items',
  );
  await at(545, 345);
  assert.ok(
    await rect('[aria-label="Bring to front"]'),
    'overlapping siblings offer local ordering',
  );
  const order = async () => [...(await state()).objects].sort((a, b) => a.z - b.z).map((o) => o.id);
  const initial = ['a', 'solo', 'local', 'sibling', 'covered', 'b', 'foreign', 'foreign-covered'];
  const locallyRaised = [
    'a',
    'solo',
    'sibling',
    'covered',
    'local',
    'b',
    'foreign',
    'foreign-covered',
  ];
  await click('[aria-label="Bring to front"]');
  await until(
    async () => JSON.stringify(await order()) === JSON.stringify(locallyRaised),
    'local item stays below the complete overlying frame',
  );
  await screenshot('hierarchy-local.png');
  await key('z', 'KeyZ', 2);
  await until(
    async () => JSON.stringify(await order()) === JSON.stringify(initial),
    'undo local ordering',
  );
  await key('z', 'KeyZ', 10);
  await until(
    async () => JSON.stringify(await order()) === JSON.stringify(locallyRaised),
    'redo local ordering',
  );
  await at(182, 460);
  await click('[aria-label="Bring to front"]');
  const frameRaised = [
    'b',
    'foreign',
    'foreign-covered',
    'a',
    'solo',
    'sibling',
    'covered',
    'local',
  ];
  await until(
    async () => JSON.stringify(await order()) === JSON.stringify(frameRaised),
    'whole frame moves without taking foreign contents',
  );
  await screenshot('hierarchy-frame.png');
  // The next drag must use the same ownership and leave B's contents in place.
  const start = { x: canvas.x + 182, y: canvas.y + 460 };
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...start,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    modifiers: 1,
  });
  for (let step = 1; step <= 10; step++)
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: start.x - (140 * step) / 10,
      y: start.y,
      button: 'left',
      buttons: 1,
      modifiers: 1,
    });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: start.x - 140,
    y: start.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    modifiers: 1,
  });
  const dragged = await until(async () => {
    const objects = (await state()).objects;
    return Math.abs(objects.find((o) => o.id === 'a').x - 40) < 0.01 && objects;
  }, 'frame drag');
  for (const original of hierarchyObjects) {
    const expectedX =
      original.x - (['a', 'solo', 'local', 'sibling', 'covered'].includes(original.id) ? 140 : 0);
    assert.ok(
      Math.abs(dragged.find((o) => o.id === original.id).x - expectedX) < 0.01,
      `${original.id} retains frame membership`,
    );
  }
  await send('Page.reload');
  await until(
    () =>
      read(
        `!!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading') && !document.querySelector('#startup-screen')`,
      ),
    'hierarchy reload',
  );
  assert.deepEqual(await order(), frameRaised);
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
  await until(
    () =>
      read(
        `!!document.querySelector('.canvas-surface canvas') && document.querySelectorAll('.canvas-list').length===${frameCheck ? 0 : 4} && !document.querySelector('.canvas-loading') && !document.querySelector('#startup-screen')`,
      ),
    'canvas',
  );
  await read(`document.documentElement.dataset.theme='dark'`);
  if (hierarchyCheck) {
    await hierarchyChecks();
  } else if (frameCheck) {
    await frameChecks();
  } else {
    await selectBack();
    assert.ok(
      await rect('[aria-label="Bring to front"]'),
      'overlapping item has a Bring to front ribbon button',
    );
    const front = await rect('[data-list-id="front"]');
    const point = { x: front.x + 20, y: front.y + 20 };
    assert.equal(await topListAt(point.x, point.y), 'front');
    await screenshot('before.png');
    await click('[aria-label="Bring to front"]');
    await until(
      async () => (await topListAt(point.x, point.y)) === 'back',
      'back card visibly above both other cards',
    );
    await until(
      async () => (await state()).objects.find((o) => o.id === 'back').z > 4,
      'saved front order',
    );
    await screenshot('after.png');
    await key('z', 'KeyZ', 2);
    await until(
      async () => (await topListAt(point.x, point.y)) === 'front',
      'undo restores visible order',
    );
    await key('z', 'KeyZ', 10);
    await until(
      async () => (await topListAt(point.x, point.y)) === 'back',
      'redo restores visible order',
    );
    await until(
      async () => (await state()).objects.find((o) => o.id === 'back').z > 4,
      'redo saved',
    );
    const r = await rect('[data-list-id="alone"]');
    await mouse('mousePressed', r.x + 24, r.y + 20, 1);
    await mouse('mouseReleased', r.x + 24, r.y + 20);
    await until(
      () => read(`document.querySelector('[data-list-id="alone"]').dataset.selected==='true'`),
      'isolated selected',
    );
    assert.equal(
      await rect('[aria-label="Bring to front"]'),
      null,
      'isolated item has no stacking button',
    );
    await send('Page.reload');
    await until(
      () =>
        read(
          `document.querySelectorAll('.canvas-list').length===4 && !document.querySelector('.canvas-loading') && !document.querySelector('#startup-screen')`,
        ),
      'reloaded cards',
    );
    await until(
      async () => (await topListAt(point.x, point.y)) === 'back',
      'reloaded visible order',
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    'STACKING_DESKTOP_OK',
    JSON.stringify({
      root,
      frameCheck,
      hierarchyCheck,
      checks: [
        'overlap ribbon',
        'visible order',
        'undo',
        'redo',
        'no overlap hidden',
        'saved reload',
        'no renderer errors',
      ],
    }),
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
