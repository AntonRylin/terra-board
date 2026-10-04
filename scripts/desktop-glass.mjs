// Real pointer docking checks against an isolated desktop library.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/glass-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Liquid glass review' });
const folder = store.createFolder({ name: 'Docking folder' });
store.createBoard({ name: 'Inside folder', folderId: folder.id });
store.patchBoard({
  id: board.id,
  revision: 0,
  upserts: [
    {
      id: 'scene-blue',
      type: 'rect',
      x: 0,
      y: 590,
      width: 580,
      height: 360,
      z: 0,
      color: '#87afc5',
    },
    {
      id: 'scene-green',
      type: 'rect',
      x: 580,
      y: 590,
      width: 380,
      height: 360,
      z: 1,
      color: '#92b3a0',
    },
    {
      id: 'scene-peach',
      type: 'rect',
      x: 960,
      y: 590,
      width: 420,
      height: 360,
      z: 2,
      color: '#e1bea2',
    },
    {
      id: 'title',
      type: 'text',
      x: 180,
      y: 180,
      width: 880,
      height: 90,
      z: 3,
      fontSize: 48,
      text: 'A little more light.',
      color: '#27303d',
    },
    {
      id: 'subtitle',
      type: 'text',
      x: 180,
      y: 285,
      width: 880,
      height: 70,
      z: 4,
      fontSize: 22,
      text: 'Your canvas, through a softer layer.',
      color: '#6b7c90',
    },
    {
      id: 'small-note',
      type: 'note',
      x: 790,
      y: 360,
      width: 270,
      height: 190,
      z: 5,
      text: 'Collect something\nthat inspires you.',
      fontSize: 24,
      color: '#f8efd4',
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
const executable = process.env.CANVAS_EXECUTABLE || require('electron');
const child = spawn(
  executable,
  [...(process.env.CANVAS_EXECUTABLE ? [] : ['.']), `--remote-debugging-port=${port}`],
  {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let diagnostics = '';
child.stderr.on('data', (b) => (diagnostics += b));
child.stdout.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(80);
  }
  throw Error('Timed out: ' + label);
};
let socket,
  nextId = 0;
const pending = new Map(),
  errors = [];
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId,
      timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('CDP timeout: ' + method));
      }, 15000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
const read = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails)
    throw Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description);
  return r.result.value;
};
const rect = (selector) =>
  read(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()`,
  );
const mouse = (type, x, y, button = 'left', clickCount = 1) =>
  send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button,
    buttons: type === 'mouseReleased' ? 0 : button === 'right' ? 2 : 1,
    clickCount,
  });
const click = async (x, y, button = 'left', count = 1) => {
  await mouse('mousePressed', x, y, button, count);
  await mouse('mouseReleased', x, y, button, count);
};
const doubleClick = async (x, y) => {
  await click(x, y);
  await sleep(60);
  // Already-selected plain text opens on that single click. Do not add a
  // second click inside its newly focused textarea and change the selection.
  if (await read(`!!document.querySelector('.text-editor')`)) return;
  await click(x, y, 'left', 2);
  await sleep(100);
};
const clickSelector = async (selector) => {
  await sleep(100);
  const r = await rect(selector);
  assert.ok(r, selector);
  await click(r.x + r.width / 2, r.y + r.height / 2);
};
const key = async (key, code, modifiers = 0) => {
  const windowsVirtualKeyCode = code.startsWith('Key')
    ? code.charCodeAt(3)
    : { Enter: 13, Backspace: 8, Escape: 27, Tab: 9, Delete: 46 }[code] || 0;
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
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
try {
  const target = await until(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === 'page' && t.url.startsWith('canvas-app:'),
      );
    } catch {
      return null;
    }
  }, 'packaged page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    socket.addEventListener('open', r, { once: true });
    socket.addEventListener('error', j, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
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
    () => read(`!!document.querySelector('canvas')&&!document.querySelector('.canvas-loading')`),
    'canvas ready',
  );
  await send('Page.enable');
  const reload = async () => {
    const loaded = new Promise((resolve) => {
      const listener = (event) => {
        if (JSON.parse(event.data).method === 'Page.loadEventFired') {
          socket.removeEventListener('message', listener);
          resolve();
        }
      };
      socket.addEventListener('message', listener);
    });
    await send('Page.reload');
    await loaded;
    await sleep(220);
    await until(
      () => read(`!!document.querySelector('canvas')&&!document.querySelector('.canvas-loading')`),
      'reloaded canvas',
    );
  };
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await read(
    `localStorage.setItem('terra-board.launcher-edge','bottom');localStorage.setItem('terra-board.launcher-centered','true')`,
  );
  await reload();
  await until(
    () =>
      read(
        `document.querySelector('.app-shell')?.dataset.dock==='bottom'&&!!document.querySelector('canvas')&&!document.querySelector('.canvas-loading')`,
      ),
    'bottom dock loaded',
  );
  const screenshot = async (name) => {
    await sleep(250);
    const shot = await send('Page.captureScreenshot');
    writeFileSync(join(root, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  const openSettings = async () => {
    const panel = await rect('.launcher');
    await click(panel.x + panel.width / 2, panel.y + panel.height - 12, 'right');
    await until(() => read(`!!document.querySelector('.context-menu')`), 'library menu');
    await read(
      `Array.from(document.querySelectorAll('.context-menu button')).find(b=>b.textContent==='Settings').click()`,
    );
    await until(
      () => read(`!!document.querySelector('#panel-transparency')`),
      'appearance settings',
    );
  };
  const material = (selector) =>
    read(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});const s=getComputedStyle(e);return {fill:Number(s.getPropertyValue('--glass-fill')),background:s.backgroundColor,backdrop:s.backdropFilter,opacity:s.opacity,border:s.borderRadius}})()`,
    );
  assert.equal(
    await read(`localStorage.getItem('terra-board.panel-transparency')`),
    '55',
    'default transparency',
  );
  for (const selector of ['.launcher', '.toolbar-glass']) {
    const m = await material(selector);
    assert.ok(m.backdrop.includes('blur(24px)'), 'real backdrop blur');
    assert.equal(m.opacity, '1', 'content stays opaque');
    assert.ok(Math.abs(m.fill - 0.45) < 0.001, 'default fill');
  }
  await screenshot('board-default');
  await openSettings();
  assert.equal(await read(`document.querySelector('#panel-transparency').value`), '55');
  await screenshot('settings-default');
  await read(`document.querySelector('#panel-transparency').focus()`);
  await key('Home', 'Home');
  await sleep(240);
  assert.equal(
    await read(`document.querySelector('#panel-transparency').value`),
    '0',
    'keyboard slider to solid',
  );
  assert.equal((await material('.launcher')).fill, 1);
  assert.equal((await material('.toolbar-glass')).fill, 1);
  assert.equal((await material('.glass-preview-tools')).fill, 1);
  await screenshot('settings-solid');
  await key('End', 'End');
  await sleep(240);
  assert.equal(
    await read(`document.querySelector('#panel-transparency').value`),
    '100',
    'keyboard slider to clear',
  );
  assert.equal((await material('.launcher')).fill, 0);
  assert.equal((await material('.toolbar-glass')).fill, 0);
  assert.equal((await material('.glass-preview-tools')).fill, 0);
  assert.equal(
    await read(`localStorage.getItem('terra-board.panel-transparency')`),
    '100',
    'saved',
  );
  await screenshot('settings-clear');
  await key('Escape', 'Escape');
  await until(() => read(`!document.querySelector('.settings-page')`), 'settings closes');
  await screenshot('board-clear');
  await reload();
  await until(
    () => read(`!!document.querySelector('canvas')&&!document.querySelector('.canvas-loading')`),
    'reload',
  );
  assert.equal((await material('.launcher')).fill, 0, 'preference survives reload');
  await openSettings();
  await clickSelector('.glass-reset');
  await sleep(240);
  assert.equal(
    await read(`document.querySelector('#panel-transparency').value`),
    '55',
    'reset default',
  );
  await clickSelector('[aria-label="Back to board"]');
  // Selection tools get the same material without moving their object coordinates.
  await click(900, 440);
  await until(
    () =>
      read(
        `!!document.querySelector('.selection-tools')&&getComputedStyle(document.querySelector('.selection-tools')).visibility==='visible'`,
      ),
    'selection toolbar',
  );
  assert.ok((await material('.selection-tools')).backdrop.includes('blur(24px)'));
  await key('Escape', 'Escape');
  const overlap = (a, b) =>
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    await read(`localStorage.setItem('terra-board.launcher-edge',${JSON.stringify(edge)})`);
    await reload();
    await until(
      () =>
        read(
          `document.querySelector('.app-shell')?.dataset.dock===${JSON.stringify(edge)}&&!!document.querySelector('canvas')&&!document.querySelector('.canvas-loading')`,
        ),
      'dock ' + edge,
    );
    const rail = await rect('.launcher'),
      surface = await rect('.canvas-surface'),
      toolbar = await rect('.canvas-toolbar'),
      header = await rect('.board-header');
    assert.deepEqual(
      rail,
      edge === 'left'
        ? { x: 0, y: 0, width: 72, height: 900 }
        : edge === 'right'
          ? { x: 1208, y: 0, width: 72, height: 900 }
          : edge === 'top'
            ? { x: 0, y: 0, width: 1280, height: 72 }
            : { x: 0, y: 828, width: 1280, height: 72 },
      'dock fills its side without edge gaps',
    );
    const marker = await read(
      `(()=>{const el=document.querySelector('.launch-item.active'),s=getComputedStyle(el,'::before');return {width:parseFloat(s.width),height:parseFloat(s.height),top:parseFloat(s.top),left:parseFloat(s.left),tileWidth:el.offsetWidth,tileHeight:el.offsetHeight}})()`,
    );
    if (edge === 'left' || edge === 'right') {
      assert.equal(marker.width, 3, 'vertical marker keeps its thickness');
      assert.ok(marker.height > 14, 'vertical marker is longer');
      assert.ok(
        Math.abs(marker.top + marker.height / 2 - marker.tileHeight / 2) < 1,
        'vertical marker stays centered',
      );
    } else {
      assert.equal(marker.height, 3, 'horizontal marker keeps its thickness');
      assert.ok(marker.width > 14, 'horizontal marker is longer');
      assert.ok(
        Math.abs(marker.left + marker.width / 2 - marker.tileWidth / 2) < 1,
        'horizontal marker stays centered',
      );
    }
    assert.equal((await material('.launcher')).border, '0px', 'no rounded corner gaps');
    assert.ok(overlap(rail, surface) > 0, 'canvas renders beneath dock');
    assert.equal(overlap(rail, toolbar), 0, 'tools stay clear of dock');
    assert.equal(overlap(rail, header), 0, 'header stays clear of dock');
  }
  await send('Emulation.setDeviceMetricsOverride', {
    width: 480,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(200);
  await openSettings();
  assert.ok((await rect('.appearance-settings')).width < 480, 'narrow appearance layout');
  await screenshot('settings-narrow');
  await key('Escape', 'Escape');
  // Invalid settings recover instead of breaking styles.
  await read(`localStorage.setItem('terra-board.panel-transparency','invalid')`);
  await reload();
  await until(
    () => read(`!!document.querySelector('canvas')&&!document.querySelector('.canvas-loading')`),
    'invalid-setting reload',
  );
  assert.equal(await read(`localStorage.getItem('terra-board.panel-transparency')`), '55');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks:
        'Live slider, solid/clear extremes, shared preview and panel material, crisp content, persistence, reset, all dock edges, selection controls, narrow settings, corrupt preference fallback',
      artifacts: root,
    }),
  );
} catch (error) {
  console.error(error, diagnostics);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
