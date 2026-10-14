// End-to-end appearance checks against a disposable packaged desktop library.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/night-mode-'));
const store = new Store(root);
const board = store.createBoard({ name: 'After hours' });
store.createBoard({ name: 'Collected things' });
const folder = store.createFolder({ name: 'Ideas' });
store.createBoard({ name: 'Sketchbook', folderId: folder.id });
const objects = [
  {
    id: 'title',
    type: 'text',
    x: 180,
    y: 140,
    width: 960,
    height: 100,
    z: 0,
    fontSize: 46,
    text: 'A quieter kind of canvas.',
    color: '#27303d',
  },
  {
    id: 'subtitle',
    type: 'text',
    x: 185,
    y: 235,
    width: 800,
    height: 55,
    z: 1,
    fontSize: 19,
    text: 'A little light. A little space. Something worth keeping.',
    color: '#6b7c90',
  },
  {
    id: 'amber',
    type: 'note',
    x: 220,
    y: 380,
    width: 255,
    height: 220,
    z: 2,
    rotation: 355,
    fontSize: 24,
    text: 'Leave a little\nroom for wonder.',
    color: '#f8efd4',
  },
  {
    id: 'sage',
    type: 'note',
    x: 575,
    y: 475,
    width: 255,
    height: 200,
    z: 3,
    rotation: 4,
    fontSize: 23,
    text: 'Good ideas\nneed space\nto breathe.',
    color: '#b4dacd',
  },
  { id: 'blue', type: 'ellipse', x: 965, y: 340, width: 175, height: 175, z: 4, color: '#a5cafa' },
  {
    id: 'card',
    type: 'rect',
    x: 670,
    y: 320,
    width: 195,
    height: 100,
    z: 5,
    text: 'Slow down.\nLook closer.',
    color: '#eeeeee',
    fontSize: 18,
  },
];
store.patchBoard({ id: board.id, revision: 0, upserts: objects, camera: { x: 0, y: 0, zoom: 1 } });
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
  await read(
    `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`,
  );
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
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const media = async (dark, reduced = false) =>
    send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' },
        { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' },
      ],
    });
  const reload = async () => {
    await send('Page.reload');
    await sleep(500);
    await until(
      () => read('!!document.querySelector("canvas")&&!document.querySelector(".canvas-loading")'),
      'reloaded',
    );
  };
  const screenshot = async (name) => {
    await sleep(550);
    const shot = await send('Page.captureScreenshot');
    writeFileSync(join(root, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  const theme = () => read('document.documentElement.dataset.theme');
  const openSettings = async () => {
    const panel = await rect('.launcher');
    assert.ok(panel, 'board panel');
    await click(panel.x + panel.width - 8, panel.y + panel.height / 2, 'right');
    await until(() => read('!!document.querySelector(".context-menu")'), 'library menu');
    await read(
      'Array.from(document.querySelectorAll(".context-menu button")).find(b=>b.textContent==="Settings").click()',
    );
    await until(() => read(`!!document.querySelector('.st-nav')`), 'settings sections');
    await read(
      `Array.from(document.querySelectorAll('.st-nav-item')).find(b=>b.textContent==='Appearance').click()`,
    );
    await until(() => read('!!document.querySelector(".theme-switch")'), 'theme control');
  };
  const setTheme = async (mode) => {
    await read(
      'Array.from(document.querySelectorAll(".theme-switch button")).find(b=>b.textContent===' +
        JSON.stringify(mode) +
        ').click()',
    );
    await sleep(550);
  };
  const closeSettings = async () => {
    await clickSelector('[aria-label="Back to board"]');
    await until(() => read('!document.querySelector(".settings-page")'), 'settings dismissed');
  };
  await media(false);
  await read(
    "localStorage.setItem('terra-board.theme','system');localStorage.setItem('terra-board.launcher-edge','bottom');localStorage.setItem('terra-board.launcher-centered','true')",
  );
  await reload();
  assert.equal(await theme(), 'light');
  await screenshot('light-board');
  await openSettings();
  assert.equal(
    await read('document.querySelector(".theme-switch [aria-checked=true]").textContent'),
    'System',
  );
  await setTheme('Dark');
  assert.equal(await theme(), 'dark');
  assert.equal(await read("localStorage.getItem('terra-board.theme')"), 'dark');
  await screenshot('dark-settings');
  const material = () =>
    read(
      '(()=>{const s=getComputedStyle(document.querySelector(".launcher"));return {bg:s.backgroundColor,filter:s.backdropFilter,fill:Number(s.getPropertyValue("--glass-fill"))}})()',
    );
  assert.ok((await material()).filter.includes('blur(24px)'));
  assert.ok(Math.abs((await material()).fill - 0.45) < 0.001);
  await closeSettings();
  await screenshot('dark-board');
  const lit = await read('document.querySelector(".night-lighting").toDataURL()');
  assert.ok(
    await read(
      '(()=>{const c=document.querySelector(".night-lighting");return c.getContext("2d").getImageData(100,300,1,1).data[3]>0})()',
    ),
    'light spills outside objects',
  );
  await reload();
  assert.equal(await theme(), 'dark', 'saved theme survives restart');
  assert.equal(await read('document.querySelector(".night-lighting").hidden'), false);
  await mouse('mousePressed', 300, 480);
  await mouse('mouseMoved', 350, 470);
  await mouse('mouseReleased', 350, 470);
  await sleep(250);
  assert.notEqual(
    await read('document.querySelector(".night-lighting").toDataURL()'),
    lit,
    'light follows object drag',
  );
  // Actual pan and zoom change lighting with the same camera as the content.
  await mouse('mousePressed', 500, 740, 'right');
  await mouse('mouseMoved', 550, 770, 'right');
  await mouse('mouseReleased', 550, 770, 'right');
  await sleep(250);
  assert.notEqual(
    await read('document.querySelector(".night-lighting").toDataURL()'),
    lit,
    'light follows pan',
  );
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 600,
    y: 450,
    deltaX: 0,
    deltaY: -140,
  });
  await sleep(500);
  assert.notEqual(
    await read('document.querySelector(".night-lighting").toDataURL()'),
    lit,
    'light follows zoom',
  );
  await openSettings();
  await clickSelector('[aria-label="Night glow"]');
  await until(() => read('document.querySelector(".night-lighting").hidden'), 'glow disabled');
  assert.equal(await read('document.querySelector(".night-lighting").hidden'), true, 'glow off');
  await closeSettings();
  await screenshot('dark-no-glow');
  await openSettings();
  await clickSelector('[aria-label="Night glow"]');
  await until(() => read('!document.querySelector(".night-lighting").hidden'), 'glow enabled');
  // Real keyboard slider works at both ends without losing the glass material.
  await read('document.querySelector("#panel-transparency").focus()');
  await key('Home', 'Home');
  await sleep(250);
  assert.equal((await material()).fill, 1);
  await key('End', 'End');
  await sleep(250);
  assert.equal((await material()).fill, 0);
  assert.ok((await material()).filter.includes('blur(24px)'));
  await screenshot('dark-clear-glass');
  await setTheme('System');
  await media(false);
  await sleep(600);
  assert.equal(await theme(), 'light');
  await media(true);
  await sleep(600);
  assert.equal(await theme(), 'dark');
  await setTheme('Light');
  await media(true);
  await sleep(200);
  assert.equal(await theme(), 'light', 'explicit mode wins over OS');
  await media(true, true);
  await read('document.querySelector(".theme-switch [aria-checked=true]").focus()');
  await key('ArrowRight', 'ArrowRight');
  await sleep(100);
  assert.equal(await theme(), 'dark', 'keyboard selects dark');
  assert.equal(
    await read('document.querySelector(".theme-switch [aria-checked=true]").textContent'),
    'Dark',
  );
  assert.equal(
    await read(
      'getComputedStyle(document.querySelector(".theme-switch-thumb")).transitionDuration',
    ),
    '0s',
    'reduced motion',
  );
  await send('Emulation.setDeviceMetricsOverride', {
    width: 540,
    height: 740,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const switchRect = await rect('.theme-switch');
  assert.ok(
    switchRect.x >= 0 && switchRect.x + switchRect.width <= 540,
    'small-window switch fits',
  );
  await screenshot('dark-small-settings');
  const persisted = await read(
    'window.canvas.invoke("loadBoard",{id:' + JSON.stringify(board.id) + '})',
  );
  assert.deepEqual(
    persisted.objects.map((o) => [o.id, o.color, o.text]).sort(),
    objects.map((o) => [o.id, o.color, o.text]).sort(),
    'appearance never rewrites content',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      artifacts: root,
      checks:
        'Light/dark/system, OS changes, explicit override, reload, keyboard, reduced motion, small window, glass opacity, glow switch, pan/zoom lighting, unchanged content',
      errors,
    }),
  );
} catch (error) {
  console.error(error, diagnostics);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
