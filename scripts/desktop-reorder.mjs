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
const inner = [0, 1, 2, 3, 4, 5].map((i) =>
  store.createBoard({ name: 'Inside ' + i, folderId: folder.id }),
);
const extra = [0, 1, 2].map((i) => store.createBoard({ name: 'Board ' + i }));
const secondFolder = store.createFolder({ name: 'Second folder' });
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
  await read(
    `window.dragLog=[];for(const name of ['dragstart','dragover','drop','dragend']) document.addEventListener(name,e=>dragLog.push({name,target:e.target.closest('[data-reorder-id]')?.dataset.reorderId,source:document.querySelector('.reorder-source')?.dataset.reorderId,time:performance.now()}),true)`,
  );
  await until(
    () => read(`!!document.querySelector('canvas')&&!document.querySelector('.canvas-loading')`),
    'canvas ready',
  );
  let dragData;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Input.dragIntercepted') dragData = message.params.data;
  });
  await send('Input.setInterceptDrags', { enabled: true });
  const selector = (id) => `[data-reorder-id="${id}"]`;
  const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const begin = async (id, to) => {
    dragData = null;
    const from = center(await rect(selector(id)));
    await mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= 10; i++)
      await mouse(
        'mouseMoved',
        from.x + ((to.x - from.x) * i) / 10,
        from.y + ((to.y - from.y) * i) / 10,
      );
    await until(() => dragData, 'native drag starts');
    for (const type of ['dragEnter', 'dragOver'])
      await send('Input.dispatchDragEvent', { type, ...to, data: dragData });
  };
  const finish = async (to) => {
    await send('Input.dispatchDragEvent', { type: 'dragOver', ...to, data: dragData });
    await send('Input.dispatchDragEvent', { type: 'drop', ...to, data: dragData });
    await mouse('mouseReleased', to.x, to.y);
    await sleep(350);
  };
  const rootOrder = () =>
    read(
      `window.canvas.invoke('library').then(l=>[...l.boards.filter(b=>!b.folderId&&!b.trashed),...l.folders].sort((a,b)=>a.position-b.position).map(i=>i.id))`,
    );
  const expected = [board.id, folder.id, ...extra.map((b) => b.id), secondFolder.id];
  assert.deepEqual(await rootOrder(), expected);
  const destination = center(await rect(selector(extra[1].id)));
  const original = await rect(selector(folder.id));
  await begin(board.id, destination);
  assert.equal(
    await read(
      `document.querySelector(${JSON.stringify(selector(folder.id))}).getAnimations().some(a=>a.transitionProperty==='transform')`,
    ),
    true,
    'siblings animate during held drag',
  );
  assert.deepEqual(await rootOrder(), expected, 'hover does not persist order');
  await sleep(250);
  assert.ok(
    (await rect(selector(folder.id))).y < original.y - 30,
    'folder slides into earlier slot',
  );
  writeFileSync(
    join(root, 'reorder-preview.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await finish(destination);
  assert.deepEqual(await rootOrder(), [
    folder.id,
    extra[0].id,
    extra[1].id,
    board.id,
    extra[2].id,
    secondFolder.id,
  ]);
  const first = center(await rect(selector(folder.id)));
  await begin(secondFolder.id, first);
  await finish(first);
  assert.deepEqual(
    (await rootOrder()).slice(0, 2),
    [secondFolder.id, folder.id],
    'folders reorder alongside boards',
  );
  // A cancelled drag must restore the saved layout.
  const saved = await rootOrder();
  await begin(extra[2].id, first);
  await send('Input.dispatchDragEvent', { type: 'dragCancel', ...first, data: dragData });
  await mouse('mouseReleased', first.x, first.y);
  await sleep(250);
  assert.deepEqual(await rootOrder(), saved);
  assert.equal(
    await read(`document.querySelectorAll('.reorder-source').length`),
    0,
    'cancel clears drag styling',
  );
  // Keep the existing center-to-folder drop behavior.
  const into = center(await rect(selector(folder.id)));
  await begin(extra[2].id, into);
  await finish(into);
  assert.equal(
    await read(
      `window.canvas.invoke('library').then(l=>l.boards.find(b=>b.id==='${extra[2].id}').folderId)`,
    ),
    folder.id,
  );
  await clickSelector('[aria-label="Open folder Docking folder"]');
  await sleep(250);
  const insideTarget = center(await rect(selector(inner[4].id)));
  await begin(inner[0].id, insideTarget);
  await sleep(250);
  await finish(insideTarget);
  const inside = await read(
    `window.canvas.invoke('library').then(l=>l.boards.filter(b=>b.folderId==='${folder.id}').sort((a,b)=>a.position-b.position).map(b=>b.id))`,
  );
  assert.deepEqual(
    inside.slice(0, 5),
    [inner[1].id, inner[2].id, inner[3].id, inner[4].id, inner[0].id],
    'folder grid reorders',
  );
  await send('Input.setInterceptDrags', { enabled: false });
  await read(`localStorage.setItem('terra-board.launcher-edge','top')`);
  await send('Page.reload');
  await until(
    () =>
      read(
        `document.querySelector('.app-shell')?.dataset.dock==='top' && !!document.querySelector('[data-reorder-id]')`,
      ),
    'horizontal launcher',
  );
  await sleep(300);
  await send('Input.setInterceptDrags', { enabled: true });
  const horizontalTarget = center(await rect(selector(board.id)));
  await begin(secondFolder.id, horizontalTarget);
  await sleep(250);
  await finish(horizontalTarget);
  assert.equal((await rootOrder()).at(-1), secondFolder.id, 'horizontal reorder persists');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      root,
      vertical: true,
      horizontal: true,
      folders: true,
      folderGrid: true,
      liveAnimation: true,
      cancel: true,
      errors,
    }),
  );
} catch (error) {
  console.error(error, diagnostics);
  console.error(
    JSON.stringify(
      await read(
        '({dragLog,errors:[...document.querySelectorAll(".error-banner")].map(e=>e.textContent)})',
      ),
    ),
  );
  console.error(JSON.stringify(await read('window.canvas.invoke("library")')));
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
