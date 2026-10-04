import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-toolbar-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Lists' });
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
const exportCheck = !!process.env.TERRA_EXPORT_CHECK;
const harness = join(root, 'export-main.cjs');
if (exportCheck)
  writeFileSync(
    harness,
    `
const {dialog}=require('electron');
dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(join(root, 'list-export.png'))}});
require(${JSON.stringify(resolve('electron/main.cjs'))});
`,
  );
const child = spawn(
  source || exportCheck
    ? require('electron')
    : resolve(process.env.TERRA_TEST_EXE || 'release/win-unpacked/Terra Board.exe'),
  [...(exportCheck ? [harness] : source ? [resolve('.')] : []), `--remote-debugging-port=${port}`],
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
async function mouse(type, x, y, buttons = 0) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
    buttons,
    clickCount: 1,
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
  await sleep(600);
  const zoneIds = (zone) =>
    read(
      `Array.from(document.querySelectorAll('[data-tool-zone="${zone}"] [data-tool-id]'),el=>el.dataset.toolId)`,
    );
  const stored = () =>
    read(`JSON.parse(localStorage.getItem('terra-board.toolbar-layout')||'null')`);
  const center = async (selector) => {
    const r = await rect(selector);
    assert.ok(r, selector);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const moveTo = async (from, to) => {
    for (let i = 1; i <= 12; i++) {
      await mouse(
        'mouseMoved',
        from.x + ((to.x - from.x) * i) / 12,
        from.y + ((to.y - from.y) * i) / 12,
        1,
      );
      await sleep(18);
    }
  };
  const begin = async (id) => {
    const p = await center(`[data-tool-id="${id}"] button`);
    await mouse('mousePressed', p.x, p.y, 1);
    return p;
  };
  const release = async (p) => {
    await mouse('mouseReleased', p.x, p.y);
    await sleep(500);
  };
  const original = await zoneIds('bar');
  assert.equal(
    await read(
      `new Set(Array.from(document.querySelectorAll('.toolbar-slots [data-tool-id]'),el=>el.offsetTop)).size`,
    ),
    1,
    'wide toolbar uses one row',
  );
  await click('[aria-label="Insert"]');
  assert.deepEqual(await zoneIds('inventory'), ['gallery', 'list']);
  assert.equal(await read(`document.querySelector('.insert-menu').innerText.trim()`), '');
  assert.equal(
    await read(`document.querySelectorAll('.canvas-toolbar [draggable="true"]').length`),
    0,
  );
  await read(
    `window.__nativeDrags=0;document.addEventListener('dragstart',()=>window.__nativeDrags++)`,
  );
  let from = await begin('gallery'),
    to = await center('[data-tool-id="text"]');
  await moveTo(from, to);
  assert.ok(
    await read(
      `document.querySelectorAll('.toolbar-slot').length && Array.from(document.querySelectorAll('.toolbar-slot')).some(el=>el.getAnimations().some(a=>a.playState==='running'))`,
    ),
    'siblings animate while rearranging',
  );
  assert.ok(
    await read(`!!document.querySelector('.toolbar-held-icon')`),
    'held icon follows the pointer',
  );
  await release(to);
  assert.equal((await zoneIds('bar'))[2], 'gallery');
  assert.deepEqual(await zoneIds('inventory'), ['list']);
  assert.equal((await state()).objects.length, 0, 'drag must not create a gallery');
  assert.equal(await read('window.__nativeDrags'), 0);
  from = await begin('gallery');
  to = await center('[data-tool-id="select"]');
  await moveTo(from, to);
  await release(to);
  assert.equal((await zoneIds('bar'))[0], 'gallery');
  from = await begin('gallery');
  to = await center('[data-tool-id="media"]');
  await moveTo(from, to);
  await release(to);
  assert.equal((await zoneIds('bar')).at(-1), 'gallery');
  from = await begin('note');
  to = await center('[data-tool-zone="inventory"]');
  await moveTo(from, to);
  await release(to);
  assert.ok(!(await zoneIds('bar')).includes('note'));
  assert.ok((await zoneIds('inventory')).includes('note'));
  const saved = await stored();
  from = await begin('text');
  to = { x: 100, y: 200 };
  await moveTo(from, to);
  await release(to);
  assert.deepEqual(await stored(), saved, 'outside drop cancels');
  assert.deepEqual(await zoneIds('bar'), saved.bar);
  from = await begin('select');
  to = await center('[data-tool-zone="inventory"]');
  await moveTo(from, to);
  await key('Escape');
  await release(to);
  assert.deepEqual(await stored(), saved, 'Escape cancels');
  assert.deepEqual(await zoneIds('bar'), saved.bar);
  await screenshot('toolbar-light.png');
  await read(`window.__reloadMarker=true`);
  await send('Page.reload');
  await until(async () => {
    try {
      return await read(
        `!window.__reloadMarker && !!document.querySelector('.customizable-toolbar') && !document.getElementById('startup-screen')`,
      );
    } catch {
      return false;
    }
  }, 'reload');
  assert.deepEqual(await zoneIds('bar'), saved.bar);
  await click('[aria-label="Insert"]');
  assert.deepEqual(await zoneIds('inventory'), saved.inventory);
  await click('[aria-label="Add list"]');
  await until(
    () => read(`document.querySelectorAll('.canvas-list').length===1`),
    'list click still works',
  );
  await click('[aria-label="Insert"]');
  from = await begin('list');
  to = await center('[data-tool-id="select"]');
  await moveTo(from, to);
  await release(to);
  assert.equal((await zoneIds('bar'))[0], 'list');
  assert.equal((await state()).objects.length, 1, 'moving list does not create another');
  await click('.toolbar-slots [aria-label="Add list"]');
  await until(
    () => read(`document.querySelectorAll('.canvas-list').length===2`),
    'pinned list click',
  );
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await sleep(350);
  await screenshot('toolbar-dark.png');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 430,
    height: 780,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(350);
  const viewport = await read(
    `({w:innerWidth,h:innerHeight,bar:document.querySelector('.canvas-toolbar').getBoundingClientRect().toJSON(),menu:document.querySelector('.tool-inventory').getBoundingClientRect().toJSON()})`,
  );
  assert.ok(viewport.bar.left >= 0 && viewport.bar.right <= viewport.w, 'bar fits narrow window');
  assert.ok(
    viewport.menu.left >= 0 && viewport.menu.right <= viewport.w && viewport.menu.top >= 0,
    'inventory fits narrow window',
  );
  await screenshot('toolbar-narrow.png');
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  from = await begin('gallery');
  to = await center('[data-tool-id="list"]');
  await moveTo(from, to);
  await release(to);
  assert.equal(
    (await zoneIds('bar'))[0],
    'gallery',
    'reorder works with wrapped bar and reduced motion',
  );
  assert.equal(await read(`!!document.querySelector('.toolbar-held-icon')`), false);
  assert.equal(
    await read(`getComputedStyle(document.querySelector('.canvas-toolbar')).transitionDuration`),
    '0s',
    'reduced motion disables bar resizing animation',
  );
  // Empty either container and recover all tools using the keyboard alternative.
  for (const id of await zoneIds('bar')) {
    await read(`document.querySelector('[data-tool-id="${id}"] button').focus()`);
    await key('Enter', 'Enter', 1);
    await sleep(20);
  }
  assert.deepEqual(await zoneIds('bar'), []);
  assert.equal((await zoneIds('inventory')).length, 11);
  assert.ok(await rect('[aria-label="Insert"]'), 'plus remains available with an empty bar');
  from = await begin('select');
  to = await center('[aria-label="Insert"]');
  await moveTo(from, to);
  await release(to);
  assert.deepEqual(await zoneIds('bar'), ['select'], 'dragging onto the empty bar restores a tool');
  for (const id of await zoneIds('inventory')) {
    await read(`document.querySelector('[data-tool-id="${id}"] button').focus()`);
    await key('Enter', 'Enter', 1);
    await sleep(20);
  }
  assert.deepEqual(await zoneIds('inventory'), []);
  from = await begin('select');
  to = await center('[data-tool-zone="inventory"]');
  await moveTo(from, to);
  await release(to);
  assert.deepEqual(await zoneIds('inventory'), ['select'], 'empty inventory accepts a drop');
  await click('[aria-label="Insert"]');
  from = await begin('text');
  to = { x: from.x, y: from.y - 12 };
  await moveTo(from, to);
  assert.ok(await rect('[data-tool-zone="inventory"]'), 'drag opens the inventory');
  await key('Escape');
  await release(to);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: 'TOOLBAR_DESKTOP_OK',
      root,
      checks: [
        'inventory to bar',
        'bar to inventory',
        'reorder both directions',
        'cancel outside',
        'cancel Escape',
        'no accidental activation',
        'no native drag',
        'persistence',
        'tool actions',
        'dark',
        'narrow',
        'reduced motion',
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
