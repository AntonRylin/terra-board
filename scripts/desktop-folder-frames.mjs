// Folder frames in the desktop app, on a scratch folder only: the frame lists
// what is on disk with Explorer's icons, follows changes made outside the app,
// opens sub folders, renames and undoes, makes new folders, takes files dropped
// from Explorer (moving them, as Windows does on one drive), turns a folder
// dropped on the board into a new frame, and saves a board picture dragged onto
// it. TERRA_SOURCE_CHECK=1 runs the built source; TERRA_TEST_EXE another build.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const sharp = require('sharp');

fs.mkdirSync(resolve('.local-test'), { recursive: true });
const root = fs.mkdtempSync(resolve('.local-test/desktop-folder-frames-'));
const folder = join(root, 'Files');
const outside = join(root, 'Outside');
const dropped = join(root, 'Dropped folder');
fs.mkdirSync(join(folder, 'Sub'), { recursive: true });
fs.mkdirSync(outside);
fs.mkdirSync(dropped);
fs.writeFileSync(join(folder, 'a.txt'), 'A');
fs.writeFileSync(join(folder, 'Sub', 'inner.txt'), 'inner');
fs.writeFileSync(join(outside, 'from explorer.txt'), 'E');
const png = (color, size) =>
  sharp({ create: { width: size, height: size, channels: 3, background: color } })
    .png()
    .toBuffer();
fs.writeFileSync(join(folder, 'photo.png'), await png('#3a7bd5', 400));

const library = join(root, 'Library');
const store = new Store(library);
const board = store.createBoard({ name: 'Folder frames' });
const picture = await store.importAsset({ bytes: await png('#e8833a', 300), name: 'orange.png' });
store.patchBoard({
  id: board.id,
  revision: 0,
  upserts: [
    {
      id: 'scratch',
      type: 'file',
      text: 'Files',
      file: { path: folder, kind: 'folder' },
      x: 100,
      y: 80,
      width: 640,
      height: 420,
      z: 1,
    },
    {
      id: 'picture',
      type: 'image',
      assetId: picture.id,
      imageTitle: 'Orange',
      x: 820,
      y: 120,
      width: 200,
      height: 200,
      z: 2,
    },
    {
      id: 'tile',
      type: 'file',
      text: 'a.txt',
      file: { path: join(folder, 'a.txt'), kind: 'file' },
      x: 820,
      y: 380,
      width: 112,
      height: 132,
      z: 3,
    },
  ],
  camera: { x: 0, y: 0, zoom: 1 },
});
store.setLastBoard({ id: board.id });
store.close();

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const env = { ...process.env, CANVAS_DATA_DIR: library };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const source = !!process.env.TERRA_SOURCE_CHECK;
const child = spawn(
  source
    ? require('electron')
    : resolve(process.env.TERRA_TEST_EXE || 'release/win-unpacked/Terra Board.exe'),
  [
    ...(source ? [resolve('.')] : []),
    `--remote-debugging-port=${port}`,
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
  { env, windowsHide: true, stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
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
async function clickAt(x, y, count = 1) {
  await mouse('mouseMoved', x, y);
  for (let c = 1; c <= count; c++) {
    await mouse('mousePressed', x, y, 1, c);
    await mouse('mouseReleased', x, y, 0, c);
  }
}
async function click(selector, count = 1) {
  const r = await until(() => rect(selector), selector);
  await clickAt(r.x + r.width / 2, r.y + r.height / 2, count);
}
async function key(keyName, code, windowsVirtualKeyCode, modifiers = 0) {
  for (const type of ['rawKeyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', {
      type,
      key: keyName,
      code,
      windowsVirtualKeyCode,
      modifiers,
    });
}
const item = (name) =>
  `.canvas-folder[data-file-id="scratch"] [data-path$=${JSON.stringify('\\' + name)}]`;
const names = () =>
  read(
    `[...document.querySelectorAll('.canvas-folder[data-file-id="scratch"] [data-path]')].map(e=>e.dataset.path.split('\\\\').pop()).sort()`,
  );
const objects = async () =>
  (await read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`)).objects;
const screenshot = async (name) =>
  fs.writeFileSync(
    join(root, name),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
async function drop(selectorOrPoint, files, modifiers = 0) {
  const r = typeof selectorOrPoint === 'string' ? await rect(selectorOrPoint) : null;
  const x = r ? r.x + r.width / 2 : selectorOrPoint.x,
    y = r ? r.y + r.height / 2 : selectorOrPoint.y;
  const data = { items: [], files, dragOperationsMask: 1 | 2 | 16 };
  for (const type of ['dragEnter', 'dragOver', 'drop'])
    await send('Input.dispatchDragEvent', { type, x, y, data, modifiers });
}

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

  // 1. The frame lists the folder, folders first, with Explorer's icons.
  await until(async () => (await names()).length === 3, 'listing');
  assert.deepEqual(await names(), ['Sub', 'a.txt', 'photo.png']);
  assert.equal(
    await read(
      `document.querySelector('.canvas-folder[data-file-id="scratch"] .cf-item').dataset.path.split('\\\\').pop()`,
    ),
    'Sub',
  );
  await until(
    () => read(`!!document.querySelector(${JSON.stringify(item('photo.png') + ' img')})`),
    'photo icon',
  );
  const iconSize = await read(
    `(()=>{const i=document.querySelector(${JSON.stringify(item('photo.png') + ' img')});return i.naturalWidth})()`,
  );
  assert.ok(iconSize >= 64, 'icon is at least 64 px: ' + iconSize);
  await until(
    () => read(`!!document.querySelector('.canvas-file-tile[data-file-id="tile"] img')`),
    'tile icon',
  );
  await sleep(300);
  await screenshot('1-folder.png');

  // 2. Changes made outside the app show by themselves.
  fs.writeFileSync(join(folder, 'made outside.txt'), 'x');
  await until(async () => (await names()).includes('made outside.txt'), 'outside change');
  fs.rmSync(join(folder, 'made outside.txt'));
  await until(async () => !(await names()).includes('made outside.txt'), 'outside removal');

  // 3. A double-click opens a sub folder in the frame; Back returns.
  await click(item('Sub'), 2);
  await until(async () => (await names()).join() === 'inner.txt', 'sub folder');
  assert.match(
    await read(
      `document.querySelector('.canvas-folder[data-file-id="scratch"] .cf-title').textContent`,
    ),
    /Files.*Sub/,
  );
  await click('.canvas-folder[data-file-id="scratch"] [aria-label="Back"]');
  await until(async () => (await names()).length === 3, 'back');

  // 4. F2 renames on disk; Ctrl+Z puts the old name back.
  await click(item('a.txt'));
  await key('F2', 'F2', 113);
  await until(() => read(`!!document.querySelector('.cf-rename')`), 'rename field');
  await read(`(()=>{const f=document.querySelector('.cf-rename');f.select();})()`);
  await send('Input.insertText', { text: 'renamed.txt' });
  await key('Enter', 'Enter', 13);
  await until(() => fs.existsSync(join(folder, 'renamed.txt')), 'renamed on disk');
  assert.ok(!fs.existsSync(join(folder, 'a.txt')));
  await until(async () => (await names()).includes('renamed.txt'), 'renamed in frame');
  await key('z', 'KeyZ', 90, 2);
  await until(() => fs.existsSync(join(folder, 'a.txt')), 'rename undone');
  // The tile follows its file.
  await until(
    () => read(`!document.querySelector('.canvas-file-tile[data-file-id="tile"]').dataset.missing`),
    'tile back',
  );

  // 5. New folder, named in place.
  await click('.canvas-folder[data-file-id="scratch"] [aria-label="New folder"]');
  await until(() => fs.existsSync(join(folder, 'New folder')), 'new folder on disk');
  await until(() => read(`!!document.querySelector('.cf-rename')`), 'new folder rename');
  await send('Input.insertText', { text: 'Made here' });
  await key('Enter', 'Enter', 13);
  await until(() => fs.existsSync(join(folder, 'Made here')), 'new folder named');

  // 6. Files dropped from Explorer move in (same drive); onto a folder, into it.
  await drop('.canvas-folder[data-file-id="scratch"] .cf-body', [
    join(outside, 'from explorer.txt'),
  ]);
  await until(() => fs.existsSync(join(folder, 'from explorer.txt')), 'dropped file');
  assert.ok(!fs.existsSync(join(outside, 'from explorer.txt')), 'moved, not copied');
  fs.writeFileSync(join(outside, 'into sub.txt'), 'S');
  await drop(item('Sub'), [join(outside, 'into sub.txt')]);
  await until(() => fs.existsSync(join(folder, 'Sub', 'into sub.txt')), 'dropped into sub folder');

  // 7. A folder dropped on the board becomes a folder frame; Alt makes an icon.
  const surface = await rect('.canvas-surface');
  await drop({ x: surface.x + 300, y: surface.y + surface.height - 120 }, [dropped]);
  await until(
    async () =>
      (await objects()).some(
        (o) => o.type === 'file' && o.file.kind === 'folder' && o.text === 'Dropped folder',
      ),
    'dropped folder frame',
  );
  await drop({ x: surface.x + 1100, y: surface.y + 120 }, [join(folder, 'photo.png')], 1);
  await until(
    async () =>
      (await objects()).some(
        (o) => o.type === 'file' && o.file.kind === 'file' && o.text === 'photo.png',
      ),
    'Alt drop icon',
  );

  // 8. A board picture dragged onto the frame is saved there and stays put.
  const before = (await objects()).find((o) => o.id === 'picture');
  const picRect = await read(`(async()=>{
    const d = await window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}});
    const o = d.objects.find((o) => o.id === 'picture'), c = d.camera;
    const r = document.querySelector('.canvas-surface').getBoundingClientRect();
    return { x: r.left + (o.x + o.width / 2) * c.zoom + c.x, y: r.top + (o.y + o.height / 2) * c.zoom + c.y };
  })()`);
  const body = await rect('.canvas-folder[data-file-id="scratch"] .cf-body');
  const to = { x: body.x + body.width - 80, y: body.y + body.height - 40 };
  await mouse('mouseMoved', picRect.x, picRect.y);
  await mouse('mousePressed', picRect.x, picRect.y, 1);
  for (let i = 1; i <= 12; i++)
    await mouse(
      'mouseMoved',
      picRect.x + ((to.x - picRect.x) * i) / 12,
      picRect.y + ((to.y - picRect.y) * i) / 12,
      1,
    );
  await until(
    () => read(`!!document.querySelector('.canvas-folder[data-board-drop]')`),
    'drop highlight',
  );
  await screenshot('2-board-drop.png');
  await mouse('mouseReleased', to.x, to.y, 0);
  await until(() => fs.existsSync(join(folder, 'Orange.png')), 'saved picture');
  const after = (await objects()).find((o) => o.id === 'picture');
  assert.equal(after.x, before.x);
  assert.equal(after.y, before.y);

  // 9. List view, from the header.
  await click('.canvas-folder[data-file-id="scratch"] [aria-label="Show as list"]');
  await until(
    async () => (await objects()).find((o) => o.id === 'scratch').file.view === 'list',
    'list view saved',
  );
  await until(
    () =>
      read(`!!document.querySelector('.canvas-folder[data-file-id="scratch"] .cf-row[data-path]')`),
    'list rows',
  );
  await sleep(300);
  await screenshot('3-list.png');

  // 10. More tools → Folder adds a frame of this computer's Desktop (read only here).
  await click('.toolbar-insert');
  await click('[aria-label="More tools"] [aria-label="Add folder"]');
  const desktop = await until(
    async () => (await objects()).find((o) => o.type === 'file' && o.file.root === 'desktop'),
    'desktop frame',
  );
  assert.deepEqual(desktop.file, { root: 'desktop', path: '', kind: 'folder' });
  await until(
    () =>
      read(
        `(()=>{const f=document.querySelector('.canvas-folder[data-file-id="${desktop.id}"]');return !!f?.dataset.dir && /Desktop/.test(f.querySelector('.cf-title').textContent)})()`,
      ),
    'desktop listed',
  );
  await sleep(1500);
  await screenshot('4-desktop.png');
  // Zoomed far out, a frame shows a summary instead of tiny icons.
  await read(`window.dispatchEvent(new Event('resize'))`);
  for (let i = 0; i < 14; i++) {
    const s = await rect('.canvas-surface');
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: s.x + s.width / 2,
      y: s.y + s.height / 2,
      deltaX: 0,
      deltaY: 400,
    });
    await sleep(30);
  }
  await sleep(800);
  await screenshot('5-zoomed-out.png');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ root, files: fs.readdirSync(folder).sort() }, null, 2));
} catch (error) {
  console.error(error);
  if (socket) {
    try {
      await screenshot('failure.png');
    } catch {}
  }
  console.error('Errors:', errors);
  console.error('Library:', root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
