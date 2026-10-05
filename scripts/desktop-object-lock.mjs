import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-object-lock-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Object locks' });
store.patchBoard({
  id: board.id,
  revision: 0,
  deleted: [],
  camera: { x: 0, y: 0, zoom: 1 },
  upserts: [
    {
      id: 'text',
      type: 'text',
      x: 450,
      y: 220,
      width: 360,
      height: 80,
      z: 1,
      text: 'Make it yours',
      fontSize: 44,
      color: '#48678e',
    },
    {
      id: 'note',
      type: 'note',
      x: 450,
      y: 460,
      width: 220,
      height: 180,
      z: 2,
      text: 'A note',
      fontSize: 24,
      color: '#fff0b9',
    },
    {
      id: 'arrow',
      type: 'arrow',
      x: 850,
      y: 430,
      width: 240,
      height: 100,
      z: 3,
      color: '#48678e',
      arrow: {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        line: 'straight',
        start: 'none',
        end: 'arrow',
        dash: 'solid',
        thickness: 2,
      },
    },
    {
      id: 'gallery',
      type: 'frame',
      x: 900,
      y: 600,
      width: 250,
      height: 180,
      z: 4,
      text: 'Gallery',
      gallery: { direction: 'right', gap: 16, size: 180 },
    },
  ],
});
const documentAsset = await store.importAsset({
  name: 'Draft.txt',
  bytes: Buffer.from('Original text'),
});
store.patchBoard({
  id: board.id,
  revision: 1,
  deleted: [],
  upserts: [
    {
      id: 'document',
      type: 'document',
      x: 990,
      y: 100,
      width: 320,
      height: 270,
      z: 8,
      text: 'Draft.txt',
      assetId: documentAsset.id,
      documentMime: 'text/plain',
    },
    {
      id: 'list',
      type: 'list',
      x: 80,
      y: 200,
      width: 280,
      height: 230,
      z: 5,
      text: 'Locked checklist',
      items: [{ id: 'task', text: 'Cannot change', checked: false }],
      locked: true,
    },
    { id: 'frame', type: 'frame', x: 80, y: 570, width: 420, height: 250, z: 0, text: 'Container' },
    {
      id: 'child',
      type: 'note',
      x: 150,
      y: 630,
      width: 160,
      height: 120,
      z: 1,
      text: 'Inside frame',
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
async function mouse(type, x, y, buttons = 0, clickCount = 1, modifiers = 0) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
    buttons,
    clickCount,
    modifiers,
  });
}
async function click(selector) {
  let previous;
  const r = await until(async () => {
    const next = await rect(selector);
    const stable = next && JSON.stringify(previous) === JSON.stringify(next);
    previous = next;
    return stable && next;
  }, selector + ' settled');
  const x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, 1);
  await mouse('mouseReleased', x, y);
}
async function doubleClick(selector) {
  const r = await until(() => rect(selector), selector);
  const x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  await mouse('mouseMoved', x, y);
  for (const count of [1, 2]) {
    await mouse('mousePressed', x, y, 1, count);
    await mouse('mouseReleased', x, y, 0, count);
  }
}
const key = async (key, code = key, modifiers = 0) => {
  const windowsVirtualKeyCode = { Enter: 13, Tab: 9, Escape: 27, ' ': 32 }[key] || 0;
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
    text: key === 'Enter' ? '\r' : undefined,
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
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const ready = () =>
    read(
      `!!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading') && !document.getElementById('startup-screen')`,
    );
  await until(ready, 'canvas ready');
  const at = async (x, y, count = 1) => {
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, 1, count);
    await mouse('mouseReleased', x, y, 0, count);
  };
  const choose = async (x, y) => {
    await key('Escape');
    await at(x, y);
    await until(() => rect('.object-lock'), 'selected object');
    await read(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
    );
  };

  await read(
    `window.lockEvents = []; for (const type of ['pointerdown','pointerup','pointerleave','blur']) window.addEventListener(type, e => { if(e.target === window || e.target?.classList?.contains('object-lock')) window.lockEvents.push([type,performance.now(),e.target === window ? 'window' : 'button']); },true)`,
  );
  const lock = '.object-lock';
  const locked = () => read(`document.querySelector('.object-lock')?.dataset.locked === 'true'`);
  const saved = async (id) => (await state()).objects.find((o) => o.id === id);
  const flush = async () => {
    await read('document.activeElement?.blur()');
    await key('s', 'KeyS', 2);
  };
  const hold = async (ms) => {
    let previous,
      stable = 0;
    const r = await until(async () => {
        const next = await rect(lock);
        stable = JSON.stringify(previous) === JSON.stringify(next) ? stable + 1 : 0;
        previous = next;
        return stable >= 3 && next;
      }, 'lock button settled'),
      x = r.x + r.width / 2,
      y = r.y + r.height / 2;
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, 1);
    await sleep(ms);
    return { x, y };
  };
  const drag = async (x, y, dx, dy) => {
    await mouse('mousePressed', x, y, 1);
    for (let i = 1; i <= 5; i++) await mouse('mouseMoved', x + (dx * i) / 5, y + (dy * i) / 5, 1);
    await mouse('mouseReleased', x + dx, y + dy);
  };
  await choose(530, 245);
  await click(lock);
  await until(locked, 'locked');
  await flush();
  await until(async () => (await saved('text')).locked, 'lock saved');
  const before = await saved('text');
  await screenshot('locked.png');
  assert.equal(await rect('button[aria-label="Delete selection"]'), null);
  await drag(530, 245, 100, 80);
  await at(530, 245, 2);
  assert.equal(await rect('.text-editor'), null, 'locked text cannot enter editing');
  await key('b', 'KeyB', 2);
  await key('Delete');
  await key('z', 'KeyZ', 2);
  await flush();
  assert.deepEqual(
    await saved('text'),
    before,
    'drag, double-click, formatting, delete and undo preserve lock',
  );

  let p = await hold(1300);
  await screenshot('unlock-progress.png');
  assert.ok(await locked());
  assert.equal(await read(`document.querySelector('.object-lock').dataset.holding`), 'true');
  await mouse('mouseReleased', p.x, p.y);
  assert.equal(await read(`document.querySelector('.object-lock').dataset.holding`), 'false');
  p = await hold(700);
  await mouse('mouseMoved', p.x + 120, p.y + 120, 1);
  await mouse('mouseReleased', p.x + 120, p.y + 120);
  assert.ok(await locked(), 'leaving cancels hold');

  p = await hold(4600);
  assert.ok(await locked(), 'still locked before five seconds');
  await until(async () => !(await locked()), 'continuous five-second unlock', 4000);
  await mouse('mouseReleased', p.x, p.y);
  assert.equal(await locked(), false, 'release does not relock');
  await flush();
  await until(async () => !(await saved('text')).locked, 'unlock saved');
  await screenshot('unlocked.png');
  await drag(530, 245, 80, 40);
  await flush();
  await until(async () => (await saved('text')).x !== before.x, 'movement restored');
  await at(610, 285, 2);
  await until(() => rect('.text-editor'), 'editing restored');
  await key('Escape');

  // Locked list controls remain inert, including their separate DOM editor.
  await choose(180, 230);
  assert.ok(await locked());
  const listBefore = await saved('list');
  const check = await rect('.canvas-list button');
  if (check) await at(check.x + check.width / 2, check.y + check.height / 2);
  await at(180, 230, 2);
  await flush();
  assert.deepEqual(await saved('list'), listBefore);
  assert.equal(await read(`document.querySelector('.canvas-list').dataset.editing`), 'false');

  // A frame lock covers nested items; a mixed selection cannot move its locked member.
  await choose(85, 575);
  await click(lock);
  await flush();
  await until(
    async () => (await saved('frame')).locked && (await saved('child')).locked,
    'frame and contents locked',
  );
  const childBefore = await saved('child');
  await drag(210, 690, 40, 25);
  await flush();
  assert.deepEqual(await saved('child'), childBefore);

  // Gallery controls expose the same persistent lock.
  await choose(905, 605);
  await click(lock);
  await flush();
  await until(async () => (await saved('gallery')).locked, 'gallery lock saved');
  assert.equal(
    await read(
      `Array.from(document.querySelectorAll('.gallery-controls button')).some(e => e.textContent === 'Right')`,
    ),
    false,
  );

  const oldOrigin = await read('performance.timeOrigin');
  await send('Page.reload');
  await until(
    async () => (await read('performance.timeOrigin')) !== oldOrigin && (await ready()),
    'reload ready',
  );
  await choose(905, 605);
  assert.ok(await locked(), 'lock survives reload');

  // Keyboard hold and focus-loss cancellation use the same five-second rule.
  await read(`document.querySelector('.object-lock').focus()`);
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
  });
  await sleep(600);
  await read(`document.querySelector('.canvas-surface').focus()`);
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
  });
  assert.ok(await locked());
  assert.equal(await read(`document.querySelector('.object-lock').dataset.holding`), 'false');
  await read(`document.querySelector('.object-lock').focus()`);
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
  });
  await until(async () => !(await locked()), 'keyboard unlock', 7000);
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
  });
  assert.equal(await locked(), false);
  await choose(1080, 180);
  await at(1080, 180, 2);
  await until(() => rect('.document-text-editor'), 'document editor');
  await click('.document-text-editor');
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Keep my draft before locking' });
  const documentDraft = await read(`document.querySelector('.document-text-editor').value`);
  assert.ok(documentDraft.includes('Keep my draft before locking'));
  await click(lock);
  await until(locked, 'document locked');
  await flush();
  await until(
    async () => (await saved('document')).documentExcerpt === documentDraft,
    'document draft saved before lock',
    3000,
  );
  assert.equal(await read(`document.querySelector('.document-text-editor').readOnly`), true);
  await screenshot('locked-document.png');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: 'OBJECT_LOCK_DESKTOP_OK',
      root,
      checks: [
        'click lock',
        'persistence',
        'movement and editing blocked',
        'format/delete/undo blocked',
        'early-release cancellation',
        'pointer-leave cancellation',
        'five-second hold',
        'editing and movement restored',
        'locked list',
        'frame contents',
        'gallery',
        'keyboard hold',
        'focus-loss cancellation',
        'document draft saved before locking',
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
      console.error(await read('window.lockEvents'));
    } catch {}
  }
  console.error('Library:', root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
