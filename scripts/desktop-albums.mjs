// Albums in the desktop app: a file dropped from disk onto an album that links
// files keeps only a preview in the library; a moved original shows the saved
// preview with a warning in the album viewer, and the board says why.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const sharp = require('sharp');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/albums-'));
const outside = mkdtempSync(resolve('.local-test/albums-files-'));
const picture = (background, width) =>
  sharp({ create: { width, height: 300, channels: 3, background } })
    .png()
    .toBuffer();
const store = new Store(root);
const board = store.createBoard({ name: 'Albums' });
const a = await store.importAsset({ bytes: await picture('#c0504d', 600), name: 'a.png' });
const b = await store.importAsset({ bytes: await picture('#4f81bd', 500), name: 'b.png' });
const album = {
  id: 'album',
  type: 'image',
  x: 100,
  y: 100,
  width: 400,
  height: 200,
  z: 1,
  assetId: a.id,
  album: {
    name: 'Trip',
    storage: 'link',
    images: [
      { id: 'one', assetId: a.id, width: 400, height: 200 },
      { id: 'two', assetId: b.id, width: 300, height: 180 },
    ],
  },
};
store.patchBoard({ id: board.id, revision: 0, upserts: [album], deleted: [] });
store.saveCamera({ id: board.id, camera: { x: 0, y: 0, zoom: 1 } });
store.setLastBoard({ id: board.id });
store.close();
const dropFile = join(outside, 'mountain.png');
const dropBytes = await picture('#9bbb59', 640);
writeFileSync(dropFile, dropBytes);
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
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
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
    : { Enter: 13, Backspace: 8, Escape: 27, F11: 122, Tab: 9, Delete: 46, ArrowRight: 39 }[code] ||
      0;
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

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const documentState = () =>
    read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
  const saved = async (test, label) =>
    until(async () => {
      const d = await documentState();
      return test(d) ? d : null;
    }, label);
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(root, name + '.png'), Buffer.from(s.data, 'base64'));
  };
  await until(
    () => read(`!!document.querySelector('[aria-label="Saved locally"]')`),
    'board loaded',
  );
  await sleep(500);
  const surface = await until(() => rect('.canvas-surface'), 'board surface');
  const c = (await documentState()).camera;
  const on = (x, y) => ({ x: surface.x + x * c.zoom + c.x, y: surface.y + y * c.zoom + c.y });
  const centre = on(album.x + album.width / 2, album.y + album.height / 2);

  // A real file from disk, dropped onto the album: it joins as a link.
  for (const type of ['dragEnter', 'dragOver', 'drop'])
    await send('Input.dispatchDragEvent', {
      type,
      ...centre,
      data: { items: [], files: [dropFile], dragOperationsMask: 1 },
    });
  let d = await saved(
    (d) => d.objects.length === 1 && d.objects[0].album?.images.length === 3,
    'dropped file joins the album',
  );
  const added = d.objects[0].album.images[2];
  const links = await read(
    `window.canvas.invoke('assetLinks',{ids:[${JSON.stringify(added.assetId)}]})`,
  );
  assert.equal(links.length, 1);
  assert.equal(links[0].state, 'ok');
  assert.equal(links[0].path.toLowerCase(), resolve(dropFile).toLowerCase());
  assert.equal(existsSync(join(root, 'assets', added.assetId + '.original')), false);
  assert.ok(existsSync(join(root, 'assets', added.assetId + '.preview')));

  // Hovering the card shows how many images it holds.
  await mouse('mouseMoved', centre.x, centre.y);
  await until(
    () => read(`document.querySelector('.album-hover-count')?.textContent.includes('3 images')`),
    'hover count',
  );
  await shot('hover');

  // The original moves away: the hover and the viewer say so, with the path.
  const moved = join(outside, 'moved.png');
  renameSync(dropFile, moved);
  await mouse('mouseMoved', surface.x + 900, surface.y + 700);
  await sleep(200);
  await mouse('mouseMoved', centre.x, centre.y);
  await until(
    () =>
      read(
        `document.querySelector('.album-hover-warning')?.textContent.includes('1 original file missing')`,
      ),
    'hover warning',
  );
  await click(centre.x, centre.y, 'left', 1);
  await click(centre.x, centre.y, 'left', 2);
  await until(() => read(`!!document.querySelector('.image-viewer')`), 'album viewer');
  for (let i = 0; i < 2; i++) {
    await key('ArrowRight', 'ArrowRight');
    await sleep(150);
  }
  await until(
    () => read(`document.querySelector('.image-viewer-position')?.textContent.trim() === '3 / 3'`),
    'third image',
  );
  const notice = await until(
    () => read(`document.querySelector('.image-viewer-notice')?.textContent || ''`),
    'missing-original notice',
  );
  assert.match(notice, /original file is missing/);
  assert.match(notice, /mountain\.png/);
  await until(
    () => read(`document.querySelector('.image-viewer')?.dataset.state === 'ready'`),
    'preview shown in the viewer',
  );
  await shot('missing-notice');

  // Settings from inside the viewer: link is allowed (the board stays local).
  await clickSelector('.image-viewer [aria-label="Album settings"]');
  await until(() => read(`!!document.querySelector('.album-settings')`), 'settings');
  assert.equal(
    await read(`document.querySelectorAll('.album-settings input[type=radio]')[1].disabled`),
    false,
  );
  assert.match(
    await read(`document.querySelector('.album-missing')?.textContent || ''`),
    /Missing: .*mountain\.png/,
  );
  await sleep(600); // past the dialog's fade-in
  await shot('settings');

  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks:
        'native file drop joins a linked album without a library copy, hover count, missing original warning on hover and in the viewer, viewer shows the preview, settings above the viewer with linking allowed on a local board',
      artifacts: root,
    }),
  );
} catch (error) {
  console.error(error, diagnostics);
  const fail = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, 'failure.png'), Buffer.from(fail.data, 'base64'));
  console.error(root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
