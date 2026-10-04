// Cross-board content search and navigation against an isolated desktop library.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/content-search-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Nebula plan' });
const folder = store.createFolder({ name: 'Projects' });
const nested = store.createBoard({ name: 'Research', folderId: folder.id });
const preview = await store.importAsset({
  name: 'preview.png',
  bytes: await require('sharp')({
    create: { width: 2, height: 2, channels: 3, background: '#b5c8e2' },
  })
    .png()
    .toBuffer(),
});
const target = {
  id: 'far-note',
  type: 'note',
  x: 12000,
  y: -7000,
  width: 320,
  height: 200,
  z: 1,
  text: 'Nebula engine review: verify the launch plan before Friday.',
  color: '#e4ecfa',
};
store.patchBoard({
  id: nested.id,
  revision: 0,
  upserts: [
    target,
    {
      ...target,
      id: 'frame',
      type: 'frame',
      x: 11600,
      y: -7400,
      width: 1100,
      height: 900,
      z: 0,
      text: 'Nebula references',
    },
    {
      ...target,
      id: 'link',
      type: 'link',
      x: 12600,
      text: 'Useful website',
      url: 'https://example.com',
      linkDescription: 'Archived Nebula research',
      linkCompact: true,
      assetId: preview.id,
    },
  ],
});
store.patchBoard({
  id: board.id,
  revision: 0,
  upserts: [
    {
      id: 'draft',
      type: 'note',
      x: 180,
      y: 180,
      width: 320,
      height: 200,
      z: 1,
      text: 'Draft before search',
      color: '#f8efd4',
    },
  ],
});
const trashed = store.createBoard({ name: 'Nebula old' });
store.patchBoard({ id: trashed.id, revision: 0, upserts: [{ ...target, id: 'trashed-note' }] });
store.updateBoard({ id: trashed.id, patch: { trashed: true } });
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
  const pageTarget = await until(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === 'page' && t.url.startsWith('canvas-app:'),
      );
    } catch {
      return null;
    }
  }, 'packaged page');
  socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
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

  const ready = () =>
    until(
      () =>
        read(`!!document.querySelector('canvas') && !document.querySelector('.canvas-loading')`),
      'canvas ready',
    );
  const search = async (query) => {
    if (!(await rect('.library-search'))) await key('f', 'KeyF', 2);
    await until(
      () => read(`document.activeElement?.matches('.search-input input')`),
      'search focused',
    );
    await key('a', 'KeyA', 2);
    await send('Input.insertText', { text: query });
    await until(
      () =>
        read(
          `!document.querySelector('.search-status[role="status"]') && !document.querySelector('.search-status[role="alert"]') && !!document.querySelector('.search-section-title')`,
        ),
      'search finished',
    );
  };
  await search('nebula');
  await until(
    () => read(`document.querySelectorAll('.content-search-result').length === 3`),
    'all content types returned',
  );
  assert.equal(
    await read(`document.querySelectorAll('.search-result-open').length`),
    1,
    'board title results stay separate',
  );
  assert.equal(
    await read(`document.querySelector('.search-results').textContent.includes('Nebula old')`),
    false,
    'trash excluded',
  );
  assert.equal(
    await read(`document.querySelectorAll('.search-excerpt mark').length`),
    3,
    'matching text highlighted',
  );
  assert.ok(
    await read(
      `document.querySelector('.search-results').textContent.includes('Research / Projects')`,
    ),
    'content shows board and folder',
  );
  const shot = await send('Page.captureScreenshot');
  writeFileSync(join(root, 'search-results.png'), Buffer.from(shot.data, 'base64'));
  await clickSelector('[data-object="far-note"]');
  await ready();
  await until(
    () =>
      read(
        `!!document.querySelector('.selection-tools') && document.querySelector('.board-title')?.textContent === 'Research'`,
      ),
    'result opens and selects item on another board',
  );
  await until(
    () =>
      read(
        `window.canvas.invoke('loadBoard', {id: ${JSON.stringify(nested.id)}}).then(d => d.camera.x < -1000)`,
      ),
    'focused camera saved',
  );
  const position = await read(
    `window.canvas.invoke('loadBoard', {id: ${JSON.stringify(nested.id)}}).then(d => ({camera: d.camera, width: document.querySelector('.canvas-surface').clientWidth, height: document.querySelector('.canvas-surface').clientHeight}))`,
  );
  assert.ok(
    Math.abs(
      (target.x + target.width / 2) * position.camera.zoom + position.camera.x - position.width / 2,
    ) < 2,
    'match centered horizontally',
  );
  assert.ok(
    Math.abs(
      (target.y + target.height / 2) * position.camera.zoom +
        position.camera.y -
        position.height / 2,
    ) < 2,
    'match centered vertically',
  );

  // Select the same result again while its board is already open.
  await search('engine review');
  await until(
    () => read(`document.querySelectorAll('.content-search-result').length === 1`),
    'specific phrase found',
  );
  await key('Enter', 'Enter');
  await until(
    () => read(`!document.querySelector('.modal') && !!document.querySelector('.selection-tools')`),
    'Enter opens the content result',
  );

  await clickSelector(`[data-item="${board.id}"]`);
  await until(
    () => read(`document.querySelector('.board-title')?.textContent === 'Nebula plan'`),
    'draft board opens',
  );
  await ready();
  const surface = await rect('.canvas-surface');
  await click(surface.x + 230, surface.y + 230);
  await click(surface.x + 230, surface.y + 230, 'left', 2);
  await until(() => read(`!!document.querySelector('.text-editor')`), 'note editor ready');
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Freshly typed quasar discovery' });
  await key('f', 'KeyF', 2);
  await until(
    () => read(`document.activeElement?.matches('.search-input input')`),
    'Ctrl+F works while editing',
  );
  await send('Input.insertText', { text: 'quasar' });
  await until(
    () =>
      read(
        `document.querySelector('.content-search-result[data-object="draft"]')?.textContent.includes('Freshly typed quasar discovery')`,
      ),
    'unsaved draft is searchable',
  );
  assert.equal(
    await read(`!!document.querySelector('.text-editor')`),
    false,
    'draft committed before searching',
  );
  assert.equal(
    await read(`document.activeElement?.matches('.search-input input')`),
    true,
    'search retains keyboard focus',
  );

  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'nebula' });
  await sleep(200);
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'no-such-phrase' });
  await until(
    () =>
      read(
        `document.querySelector('.search-status')?.textContent === 'No matching boards or content.'`,
      ),
    'latest query wins',
  );
  assert.equal(
    await read(`document.querySelectorAll('.content-search-result').length`),
    0,
    'stale results disappear',
  );
  await key('Escape', 'Escape');
  await until(() => read(`!document.querySelector('.modal')`), 'search closes');
  assert.deepEqual(errors, [], 'no runtime exceptions');
  console.log(
    JSON.stringify({
      passed: true,
      checks:
        'Ctrl+F, grouped titles and content, notes/frame/link matches, highlights, folders, trash, cross-board and same-board navigation, camera centering, Enter activation, live text drafts, stale-query handling',
      artifacts: root,
    }),
  );
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    const shot = await send('Page.captureScreenshot');
    writeFileSync(join(root, 'failure.png'), Buffer.from(shot.data, 'base64'));
  }
  console.error(error, diagnostics, root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
