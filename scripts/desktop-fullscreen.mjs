// Fullscreen menu and keyboard checks against an isolated desktop library.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/fullscreen-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Fullscreen test' });
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
const clickSelector = async (selector) => {
  await sleep(100);
  const r = await rect(selector);
  assert.ok(r, selector);
  await click(r.x + r.width / 2, r.y + r.height / 2);
};
const key = async (key, code, modifiers = 0) => {
  const windowsVirtualKeyCode = code.startsWith('Key')
    ? code.charCodeAt(3)
    : { Enter: 13, Backspace: 8, Escape: 27, F11: 122, Tab: 9, Delete: 46 }[code] || 0;
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
  const panel = await rect('.launcher');
  await click(panel.x + 32, panel.y + 3, 'right');
  await until(() => read(`!!document.querySelector('[role="menuitem"]')`), 'panel menu');
  assert.equal(
    await read(
      `[...document.querySelectorAll('[role="menuitem"]')].some(e => /full screen/i.test(e.textContent))`,
    ),
    false,
    'panel menu has no duplicate fullscreen action',
  );
  await key('Escape', 'Escape');
  const state = () => read('window.canvas.fullscreenState()');
  const bounds = () =>
    read(
      '({width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height})',
    );
  const original = await bounds();
  for (let attempt = 0; attempt < 2; attempt++) {
    await until(() => rect('.fullscreen-toggle'), 'corner icon restored');
    const icon = await rect('.fullscreen-toggle');
    const x = icon.x + icon.width / 2,
      y = icon.y + icon.height / 2;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await sleep(400);
    assert.equal(
      await read(`!!document.elementFromPoint(${x}, ${y})?.closest('.fullscreen-toggle')`),
      true,
      'hover leaves icon clickable',
    );
    assert.equal(
      await read(`!!document.querySelector('.launcher-tooltip:popover-open')`),
      false,
      'no hover label blocks icon',
    );
    await click(x, y);
    await until(state, 'corner icon entered fullscreen');
    await until(
      () => read(`!document.querySelector('.fullscreen-toggle')`),
      'icon hidden in fullscreen',
    );
    await key('Escape', 'Escape');
    await until(async () => !(await state()), 'Escape exits fullscreen');
    await until(async () => {
      const b = await bounds();
      return b.width === original.width && b.height === original.height;
    }, 'window restored after icon click');
  }
  await key('F11', 'F11');
  await until(state, 'F11 entered fullscreen');
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'F11',
    code: 'F11',
    windowsVirtualKeyCode: 122,
    autoRepeat: true,
  });
  assert.equal(await state(), true, 'held F11 does not toggle repeatedly');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, 'fullscreen.png'), Buffer.from(shot.data, 'base64'));
  await key('Escape', 'Escape');
  await until(async () => !(await state()), 'Escape exited fullscreen');
  await until(async () => {
    const b = await bounds();
    return b.width === original.width && b.height === original.height;
  }, 'original window restored');
  await key('F11', 'F11');
  await until(state, 'second F11 entered fullscreen');
  await key('F11', 'F11');
  await until(async () => !(await state()), 'F11 exited fullscreen');
  // Escape in ordinary mode still dismisses app dialogs.
  await key('k', 'KeyK', 2);
  await until(() => read('!!document.querySelector("[role=dialog]")'), 'search dialog');
  await send('Input.insertText', { text: 'draft stays open' });
  await key('F11', 'F11');
  await until(state, 'fullscreen while typing');
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await until(async () => !(await state()), 'Escape exits while typing');
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    autoRepeat: true,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  assert.equal(
    await read('document.querySelector("[role=dialog] input")?.value'),
    'draft stays open',
    'leaving fullscreen keeps the dialog and text draft',
  );
  await key('Escape', 'Escape');
  await until(() => read('!document.querySelector("[role=dialog]")'), 'normal Escape');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks:
        'Unobstructed corner icon, hidden icon in fullscreen, no duplicate menu action, F11 enter/exit, held F11, Escape exit, restored window bounds, normal Escape, renderer errors',
      artifacts: root,
    }),
  );
} catch (error) {
  console.error(error, diagnostics);
  console.error(await read('document.body.innerText'));
  const fail = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, 'failure.png'), Buffer.from(fail.data, 'base64'));
  console.error(root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
