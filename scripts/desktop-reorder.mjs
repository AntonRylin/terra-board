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
  const ready = async () => {
    await until(
      () => read(`!!document.querySelector('canvas')&&!document.querySelector('.canvas-loading')`),
      'canvas ready',
    );
    // Sorting must never enter the browser's own drag mode (ghost image, no-drop cursor).
    await read(
      `window.dragLog=[];for(const name of ['dragstart','dragover','drop','dragend']) document.addEventListener(name,e=>dragLog.push({name,target:e.target.closest?.('[data-reorder-id]')?.dataset.reorderId,time:performance.now()}),true)`,
    );
  };
  await ready();
  const selector = (id) => `[data-reorder-id="${id}"]`;
  const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const lifted = '[data-reorder-avatar]:popover-open';
  const icons = () => read(`document.querySelectorAll('.app-icon').length`);
  const shot = async (name) =>
    writeFileSync(
      join(root, name),
      Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
    );
  // Hold the tile by the middle of its icon and carry it to a point.
  const begin = async (id, to) => {
    const from = center(await rect(selector(id) + ' .app-icon'));
    await mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= 10; i++)
      await mouse(
        'mouseMoved',
        from.x + ((to.x - from.x) * i) / 10,
        from.y + ((to.y - from.y) * i) / 10,
      );
    await until(() => read(`!!document.querySelector(${JSON.stringify(lifted)})`), 'tile lifts');
  };
  const settled = () =>
    until(
      () => read(`!document.querySelector('[data-reorder-avatar],.reorder-source')`),
      'tile settles',
    );
  const finish = async (to) => {
    await mouse('mouseReleased', to.x, to.y);
    await settled();
  };
  const held = async (id, at, label) => {
    const avatar = center(await rect(lifted));
    assert.ok(
      Math.abs(avatar.x - at.x) < 2 && Math.abs(avatar.y - at.y) < 2,
      label + ': the tile itself stays under the pointer',
    );
    assert.equal(
      await read(
        `document.querySelector(${JSON.stringify(lifted)}).closest('[data-reorder-id]').dataset.reorderId`,
      ),
      id,
      label + ': the held tile is the real one',
    );
    assert.equal(
      await read(`getComputedStyle(document.querySelector('.reorder-source')).visibility`),
      'hidden',
      label + ': nothing stays behind in the old slot',
    );
    assert.equal(
      await read(`getComputedStyle(document.body).cursor`),
      'grabbing',
      label + ': no forbidden cursor',
    );
  };
  const rootOrder = () =>
    read(
      `window.canvas.invoke('library').then(l=>[...l.boards.filter(b=>!b.folderId&&!b.trashed),...l.folders].sort((a,b)=>a.position-b.position).map(i=>i.id))`,
    );
  const stripOrder = () =>
    read(
      `[...document.querySelectorAll('[data-reorder-group="root"] > [data-reorder-id]')].map(e=>e.dataset.reorderId)`,
    );
  const folderOf = (id) =>
    read(
      `window.canvas.invoke('library').then(l=>l.boards.find(b=>b.id===${JSON.stringify(id)}).folderId)`,
    );
  const expected = [board.id, folder.id, ...extra.map((b) => b.id), secondFolder.id];
  assert.deepEqual(await rootOrder(), expected);
  assert.equal(
    await read(`document.querySelector('[data-reorder-id]').draggable`),
    false,
    'internal sorting must not invoke browser ghost/cursor drag mode',
  );
  const iconCount = await icons();
  const destination = center(await rect(selector(extra[1].id)));
  const original = await rect(selector(folder.id));
  await begin(board.id, destination);
  assert.equal(
    await read(
      `[...document.querySelectorAll('[data-reorder-id]')].some(e=>e.getAnimations().some(a=>a.transitionProperty==='transform'))`,
    ),
    true,
    'siblings animate during held drag',
  );
  await held(board.id, destination, 'vertical');
  assert.equal(await icons(), iconCount, 'no duplicate ghost tile');
  assert.deepEqual(await rootOrder(), expected, 'hover does not persist order');
  await sleep(250);
  assert.ok(
    (await rect(selector(folder.id))).y < original.y - 30,
    'folder slides into earlier slot',
  );
  await shot('reorder-preview.png');
  await finish(destination);
  assert.deepEqual(await rootOrder(), [
    folder.id,
    extra[0].id,
    extra[1].id,
    board.id,
    extra[2].id,
    secondFolder.id,
  ]);
  assert.deepEqual(await stripOrder(), await rootOrder(), 'strip shows the saved order');
  assert.equal(
    await read(
      `document.querySelector(${JSON.stringify(selector(board.id) + ' .app-icon')}).getAttribute('style')`,
    ),
    null,
    'dropped tile returns to normal layout',
  );
  const first = center(await rect(selector(folder.id)));
  await begin(secondFolder.id, first);
  await finish(first);
  assert.deepEqual(
    (await rootOrder()).slice(0, 2),
    [secondFolder.id, folder.id],
    'folders reorder alongside boards',
  );
  assert.equal(
    await read(`!!document.querySelector('.folder-sheet')`),
    false,
    'finishing a drag is not a click',
  );
  // Escape during a held drag must restore the saved layout.
  const saved = await rootOrder();
  await begin(extra[2].id, first);
  await key('Escape', 'Escape');
  await mouse('mouseReleased', first.x, first.y);
  await settled();
  assert.deepEqual(await rootOrder(), saved);
  assert.equal(
    await read(`document.querySelector('.launch-item.active').dataset.reorderId`),
    board.id,
    'cancelled drag does not open the board',
  );
  // The tile is not clipped by the panel, and releasing far away changes nothing.
  const shell = await rect('.app-shell');
  const away = { x: shell.x + shell.width / 2, y: shell.y + shell.height / 2 };
  await begin(extra[0].id, away);
  await held(extra[0].id, away, 'outside the panel');
  await shot('reorder-outside.png');
  await finish(away);
  assert.deepEqual(await rootOrder(), saved, 'release away from the panel cancels');
  // Keep the existing center-to-folder drop behavior.
  const into = center(await rect(selector(folder.id)));
  await begin(extra[2].id, into);
  assert.equal(
    await read(
      `document.querySelector(${JSON.stringify(selector(folder.id))}).classList.contains('drop-target')`,
    ),
    true,
    'folder highlights as the destination',
  );
  await finish(into);
  assert.equal(await folderOf(extra[2].id), folder.id);
  // A plain click still opens the folder.
  await clickSelector('[aria-label="Open folder Docking folder"]');
  await until(() => rect('.folder-sheet'), 'folder opens on click');
  await sleep(250);
  const insideTarget = center(await rect(selector(inner[4].id)));
  await begin(inner[0].id, insideTarget);
  await held(inner[0].id, insideTarget, 'folder grid');
  await sleep(250);
  await shot('reorder-folder.png');
  await finish(insideTarget);
  const inside = await read(
    `window.canvas.invoke('library').then(l=>l.boards.filter(b=>b.folderId==='${folder.id}').sort((a,b)=>a.position-b.position).map(b=>b.id))`,
  );
  assert.deepEqual(
    inside.slice(0, 5),
    [inner[1].id, inner[2].id, inner[3].id, inner[4].id, inner[0].id],
    'folder grid reorders',
  );
  // Carry a board out of the open folder back onto the strip.
  const out = center(await rect(selector(extra[1].id)));
  await begin(inner[5].id, out);
  await finish(out);
  assert.equal(await folderOf(inner[5].id), null, 'board leaves the folder');
  assert.ok((await rootOrder()).includes(inner[5].id), 'board lands on the strip');
  await key('Escape', 'Escape');
  await until(() => read(`!document.querySelector('.folder-sheet')`), 'folder closes');
  const glide = async (from, to) => {
    for (let i = 1; i <= 10; i++)
      await mouse(
        'mouseMoved',
        from.x + ((to.x - from.x) * i) / 10,
        from.y + ((to.y - from.y) * i) / 10,
      );
  };
  // A board aimed near the edge of a folder icon still goes in, with a clear label.
  const folderSlot = await rect(selector(folder.id));
  const nearEdge = {
    x: folderSlot.x + folderSlot.width / 2,
    y: folderSlot.y + folderSlot.height * 0.2,
  };
  await begin(extra[1].id, nearEdge);
  assert.equal(
    await read(
      `document.querySelector(${JSON.stringify(selector(folder.id))}).classList.contains('drop-target')`,
    ),
    true,
    'folder edge is part of the target',
  );
  assert.equal(
    await read(`document.querySelector('.launcher-tooltip:popover-open')?.textContent`),
    'Move to Docking folder',
    'label names the destination',
  );
  assert.equal(
    await read(
      `document.querySelector(${JSON.stringify(lifted)}).hasAttribute('data-into-folder')`,
    ),
    true,
    'held board shrinks over the folder',
  );
  assert.equal(await read(`!!document.querySelector('.folder-sheet')`), false, 'no instant open');
  // Resting on the folder opens it, and the board can be placed among the others.
  await until(() => rect('.folder-sheet'), 'folder springs open', 3000);
  await sleep(300);
  await shot('reorder-spring-open.png');
  const spot = center(await rect(selector(inner[2].id)));
  await glide(nearEdge, spot);
  await finish(spot);
  assert.equal(await folderOf(extra[1].id), folder.id, 'board dropped into the opened folder');
  assert.equal(await read(`!!document.querySelector('.folder-sheet')`), true, 'folder stays open');
  const placed = await read(
    `window.canvas.invoke('library').then(l=>l.boards.filter(b=>b.folderId==='${folder.id}').sort((a,b)=>a.position-b.position).map(b=>b.id))`,
  );
  assert.ok(placed.indexOf(extra[1].id) < placed.length - 1, 'board keeps the chosen place');
  await key('Escape', 'Escape');
  await until(() => read(`!document.querySelector('.folder-sheet')`), 'folder closes');
  // A spring-opened folder closes again when the board is dropped elsewhere.
  const into2 = center(await rect(selector(folder.id)));
  await begin(extra[0].id, into2);
  await until(() => rect('.folder-sheet'), 'folder springs open again', 3000);
  const back = center(await rect(selector(board.id)));
  await glide(into2, back);
  await finish(back);
  assert.equal(await folderOf(extra[0].id), null, 'board stays on the strip');
  await until(
    () => read(`!document.querySelector('.folder-sheet')`),
    'spring-opened folder closes',
  );
  assert.deepEqual(await read('dragLog'), [], 'no browser drag events');
  await read(`localStorage.setItem('terra-board.launcher-edge','top')`);
  await send('Page.reload');
  await until(
    () =>
      read(
        `document.querySelector('.app-shell')?.dataset.dock==='top' && !!document.querySelector('[data-reorder-id]')`,
      ),
    'horizontal launcher',
  );
  await ready();
  await sleep(300);
  const horizontalTarget = center(
    await rect('[data-reorder-group="root"] > [data-reorder-id]:last-of-type'),
  );
  await begin(secondFolder.id, horizontalTarget);
  await held(secondFolder.id, horizontalTarget, 'horizontal');
  await sleep(250);
  await shot('reorder-horizontal.png');
  await finish(horizontalTarget);
  assert.equal((await rootOrder()).at(-1), secondFolder.id, 'horizontal reorder persists');
  assert.deepEqual(await read('dragLog'), [], 'no browser drag events');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      root,
      vertical: true,
      horizontal: true,
      folders: true,
      folderGrid: true,
      springOpen: true,
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
        '({dragLog:window.dragLog,errors:[...document.querySelectorAll(".error-banner")].map(e=>e.textContent)})',
      ),
    ),
  );
  console.error(JSON.stringify(await read('window.canvas.invoke("library")')));
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
