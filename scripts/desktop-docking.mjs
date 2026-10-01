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
const root = mkdtempSync(resolve('.local-test/docking-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Docking test' });
const folder = store.createFolder({ name: 'Docking folder' });
store.createBoard({ name: 'Inside folder', folderId: folder.id });
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
  const shell = await rect('.app-shell');
  const points = {
    right: { x: shell.x + shell.width - 22, y: shell.y + shell.height / 2 },
    top: { x: shell.x + shell.width / 2, y: shell.y + 22 },
    bottom: { x: shell.x + shell.width / 2, y: shell.y + shell.height - 22 },
    left: { x: shell.x + 22, y: shell.y + shell.height / 2 },
  };
  const begin = async () => {
    const r = await rect('.launcher-scroll');
    const horizontal = r.width > r.height;
    const x = horizontal ? r.x + r.width - 30 : r.x + r.width / 2;
    const y = horizontal ? r.y + r.height / 2 : r.y + r.height - 30;
    await mouse('mousePressed', x, y);
    return { x, y };
  };
  const move = async (from, to) => {
    for (let i = 1; i <= 12; i++) {
      await mouse(
        'mouseMoved',
        from.x + ((to.x - from.x) * i) / 12,
        from.y + ((to.y - from.y) * i) / 12,
      );
      await sleep(12);
    }
  };
  for (const side of ['right', 'top', 'bottom', 'left']) {
    const from = await begin();
    await move(from, points[side]);
    assert.equal(
      await read(`document.querySelector('.dock-preview')?.getAttribute('data-edge')`),
      side,
      `preview at ${side}`,
    );
    const shot = await send('Page.captureScreenshot');
    writeFileSync(join(root, `preview-${side}.png`), Buffer.from(shot.data, 'base64'));
    await mouse('mouseReleased', points[side].x, points[side].y);
    await sleep(80);
    assert.ok(
      await read(`document.querySelector('.launcher').getAnimations().length > 0`),
      'settling animation is running',
    );
    await sleep(420);
    assert.equal(await read(`document.querySelector('.app-shell').dataset.dock`), side);
    const rail = await rect('.launcher'),
      workspace = await rect('.workspace');
    assert.ok(
      side === 'top' || side === 'bottom' ? rail.width > rail.height : rail.height > rail.width,
      'correct orientation',
    );
    const overlap =
      Math.max(
        0,
        Math.min(rail.x + rail.width, workspace.x + workspace.width) -
          Math.max(rail.x, workspace.x),
      ) *
      Math.max(
        0,
        Math.min(rail.y + rail.height, workspace.y + workspace.height) -
          Math.max(rail.y, workspace.y),
      );
    assert.ok(overlap < 1, 'workspace stays clear of dock');
    await clickSelector(`[aria-label="Open folder Docking folder"]`);
    await sleep(220);
    const sheet = await rect('.folder-sheet');
    const dockedShot = await send('Page.captureScreenshot');
    writeFileSync(join(root, `docked-${side}.png`), Buffer.from(dockedShot.data, 'base64'));
    const viewport = await read(`({ width: innerWidth, height: innerHeight })`);
    assert.ok(
      sheet &&
        sheet.x >= 0 &&
        sheet.y >= 0 &&
        sheet.x + sheet.width <= viewport.width &&
        sheet.y + sheet.height <= viewport.height,
      `folder visible at ${side}`,
    );
    await clickSelector('[aria-label="Close folder"]');
    await sleep(200);
    await clickSelector('[aria-label="Create"]');
    assert.ok(await rect('.context-menu'), `Create menu opens at ${side}`);
    await key('Escape', 'Escape');
    await sleep(100);
  }
  const from = await begin();
  await move(from, points.right);
  await key('Escape', 'Escape');
  await mouse('mouseReleased', points.right.x, points.right.y);
  await sleep(450);
  assert.equal(
    await read(`document.querySelector('.app-shell').dataset.dock`),
    'left',
    'Escape cancels',
  );
  const from2 = await begin();
  const center = { x: shell.x + shell.width / 2, y: shell.y + shell.height / 2 };
  await move(from2, center);
  assert.equal(
    await read(`!!document.querySelector('.dock-preview')`),
    false,
    'no target in center',
  );
  await mouse('mouseReleased', center.x, center.y);
  await sleep(450);
  assert.equal(
    await read(`document.querySelector('.app-shell').dataset.dock`),
    'left',
    'invalid drop returns home',
  );
  const from3 = await begin();
  await move(from3, points.bottom);
  await mouse('mouseReleased', points.bottom.x, points.bottom.y);
  await sleep(450);
  await send('Page.reload');
  await until(
    () => read(`document.querySelector('.app-shell')?.dataset.dock === 'bottom'`),
    'saved dock on reload',
  );
  await until(
    () => read(`!!document.querySelector('canvas')&&!document.querySelector('.canvas-loading')`),
    'reloaded canvas',
  );
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  const from4 = await begin();
  await move(from4, points.right);
  await mouse('mouseReleased', points.right.x, points.right.y);
  await sleep(80);
  assert.equal(
    await read(`document.querySelector('.launcher').getAnimations().length`),
    0,
    'reduced motion skips flight',
  );
  assert.equal(await read(`document.querySelector('.app-shell').dataset.dock`), 'right');
  // Board icons retain their own HTML drag-and-drop gesture.
  let dragData;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Input.dragIntercepted') dragData = message.params.data;
  });
  await send('Input.setInterceptDrags', { enabled: true });
  const icon = await rect(`[data-item="${board.id}"]`);
  const folderIcon = await rect(`[data-item="${folder.id}"]`);
  await mouse('mousePressed', icon.x + icon.width / 2, icon.y + icon.height / 2);
  await move(
    { x: icon.x + icon.width / 2, y: icon.y + icon.height / 2 },
    { x: folderIcon.x + folderIcon.width / 2, y: folderIcon.y + folderIcon.height / 2 },
  );
  await until(() => dragData, 'native board drag');
  assert.equal(
    await read(`!!document.querySelector('.launcher.is-dragging')`),
    false,
    'icon drag does not move panel',
  );
  for (const type of ['dragEnter', 'dragOver', 'drop'])
    await send('Input.dispatchDragEvent', {
      type,
      x: folderIcon.x + folderIcon.width / 2,
      y: folderIcon.y + folderIcon.height / 2,
      data: dragData,
    });
  await until(
    () =>
      read(
        `window.canvas.invoke('library').then(l => l.boards.find(b => b.id === ${JSON.stringify(board.id)}).folderId === ${JSON.stringify(folder.id)})`,
      ),
    'board moved into folder',
  );
  await send('Input.setInterceptDrags', { enabled: false });
  await mouse('mouseReleased', folderIcon.x, folderIcon.y);
  const cancelFrom = await begin();
  await move(cancelFrom, points.top);
  await read(
    `document.querySelector('.launcher').dispatchEvent(new PointerEvent('pointercancel', {bubbles: true}))`,
  );
  await mouse('mouseReleased', points.top.x, points.top.y);
  assert.equal(
    await read(`document.querySelector('.app-shell').dataset.dock`),
    'right',
    'pointer cancellation restores original edge',
  );
  await send('Emulation.setDeviceMetricsOverride', {
    width: 600,
    height: 420,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await clickSelector('[aria-label="Open folder Docking folder"]');
  await sleep(180);
  const smallSheet = await rect('.folder-sheet');
  assert.ok(
    smallSheet.x >= 0 &&
      smallSheet.y >= 0 &&
      smallSheet.x + smallSheet.width <= 600 &&
      smallSheet.y + smallSheet.height <= 420,
    'folder remains inside small window',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks:
        'Four edges, live previews, animation, workspace clearance, folders, menus, Escape, invalid drop, persistence, reduced motion, native board-to-folder drag, pointer cancellation, small window',
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
