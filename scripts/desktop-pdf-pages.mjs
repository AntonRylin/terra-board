// A PDF turns into page images laid out with the chosen space, and the
// selected pages merge back into one PDF. Uses real pointer input on a
// packaged build (CANVAS_EXECUTABLE selects another) and a disposable library.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { PDFDocument, rgb } from 'pdf-lib';

const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-pdf-pages-'));
const sizes = [
  [595, 842],
  [842, 595],
  [595, 842],
];
const source = await PDFDocument.create();
for (const [index, size] of sizes.entries()) {
  const page = source.addPage(size);
  page.drawRectangle({ x: 40, y: 40, width: 120, height: 120, color: rgb(0.2, 0.4, 0.8) });
  page.drawText(`Lecture page ${index + 1}`, { x: 60, y: size[1] - 100, size: 32 });
}
let store = new Store(root);
const asset = await store.importAsset({ bytes: await source.save(), name: 'Lecture.pdf' });
const board = store.createBoard({ name: 'PDF pages' });
const card = { x: 520, y: 140, width: 320, height: 400 };
store.patchBoard({
  id: board.id,
  revision: 0,
  deleted: [],
  camera: { x: 0, y: 0, zoom: 1 },
  upserts: [
    {
      id: 'lecture',
      type: 'document',
      ...card,
      z: 1,
      text: 'Lecture.pdf',
      assetId: asset.id,
      documentMime: 'application/pdf',
      documentBytes: asset.bytes,
      documentPageCount: 3,
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
const child = spawn(
  process.env.CANVAS_EXECUTABLE || resolve('release/win-unpacked/Terra Board.exe'),
  [`--remote-debugging-port=${port}`],
  { env, windowsHide: true, stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let launchError;
child.on('error', (error) => {
  launchError = error;
});
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw Error(`App exited: ${child.exitCode}`);
    const value = await fn();
    if (value) return value;
    await sleep(80);
  }
  throw Error(`Timed out: ${label}`);
}
let socket,
  sequence = 0;
const pending = new Map(),
  errors = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(`${method} timed out`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function read(expression) {
  const value = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (value.exceptionDetails) throw Error(value.exceptionDetails.text);
  return value.result.value;
}
async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
}
async function clickSelector(selector) {
  const point = await until(
    () =>
      read(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e || e.disabled) return null;
    const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === e || e.contains(hit)) ? { x, y } : null;
  })()`),
    `clickable ${selector}`,
  );
  await click(point.x, point.y);
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, name), Buffer.from(data, 'base64'));
}
try {
  const target = await until(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === 'page' && t.url.startsWith('canvas-app:'),
      );
    } catch {}
  }, 'renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      message.error
        ? request.reject(Error(message.error.message))
        : request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown')
      errors.push(message.params.exceptionDetails);
  });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1500,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await until(
    () =>
      read(
        `!!document.querySelector('.canvas-surface') && !document.querySelector('.canvas-loading') && !document.getElementById('startup-screen')`,
      ),
    'board ready',
  );
  await sleep(500);
  const surface = await read(
    `(() => { const r = document.querySelector('.canvas-surface').getBoundingClientRect(); return { x: r.x, y: r.y }; })()`,
  );
  await click(surface.x + card.x + card.width / 2, surface.y + card.y + card.height / 2);
  await clickSelector('[aria-label="Pages to images"]');
  await until(() => read(`!!document.querySelector('[data-pdf-pages-convert]')`), 'dialog');
  await clickSelector('[data-page-stack="horizontal"]');
  // Drag the space slider with the pointer to its far end, then type an exact value.
  const slider = await read(`(() => {
    const r = document.querySelector('[aria-label="Space between pages slider"]').getBoundingClientRect();
    return { x: r.x, y: r.y + r.height / 2, width: r.width };
  })()`);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: slider.x + 4,
    y: slider.y,
    button: 'left',
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: slider.x + slider.width + 20,
    y: slider.y,
    button: 'left',
    buttons: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: slider.x + slider.width + 20,
    y: slider.y,
    button: 'left',
    clickCount: 1,
  });
  assert.equal(
    await read(`document.querySelector('[aria-label="Space between pages"]').value`),
    '1000',
    'dragging the slider sets the space',
  );
  await clickSelector('[aria-label="Space between pages"]');
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    modifiers: 2,
    windowsVirtualKeyCode: 65,
  });
  await send('Input.insertText', { text: '120' });
  assert.equal(
    await read(`document.querySelector('[aria-label="Space between pages"]').value`),
    '120',
  );
  await screenshot('dialog.png');
  await clickSelector('[data-pdf-pages-convert]');
  await until(() => read(`!document.querySelector('.modal')`), 'pages created', 60000);
  await until(
    () => read(`document.querySelector('.save-indicator')?.classList.contains('saved')`),
    'pages saved',
  );
  await sleep(800);
  await screenshot('pages.png');
  await clickSelector('[aria-label="Merge as PDF"]');
  await until(
    () =>
      read(
        `!document.querySelector('[aria-label="Merge as PDF"]') && !!document.querySelector('[aria-label="Pages to images"]')`,
      ),
    'merged PDF selected',
    60000,
  );
  await until(
    () => read(`document.querySelector('.save-indicator')?.classList.contains('saved')`),
    'merge saved',
  );
  await sleep(1500);
  await screenshot('merged.png');
  assert.deepEqual(errors, [], 'no renderer exceptions');
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  socket?.close();
  child.kill();
}
await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
await sleep(500);

store = new Store(root);
const objects = store.loadBoard({ id: board.id }).objects;
const pages = objects.filter((o) => o.type === 'image').sort((a, b) => a.x - b.x);
assert.equal(pages.length, 3, 'one image per page');
let x = card.x;
for (const [index, page] of pages.entries()) {
  assert.equal(page.y, card.y + card.height + 64, 'pages sit in a row below the PDF');
  assert.equal(page.x, x, 'pages are 120 apart');
  assert.ok(Math.abs(page.width / page.height - sizes[index][0] / sizes[index][1]) < 0.01);
  x += page.width + 120;
}
const merged = objects.find((o) => o.type === 'document' && o.id !== 'lecture');
assert.ok(merged, 'a merged PDF was added');
assert.equal(merged.text, 'Lecture.pdf');
assert.equal(merged.documentPageCount, 3);
const pdf = await PDFDocument.load(readFileSync(join(root, 'assets', merged.assetId + '.original')));
const shapes = pdf.getPages().map((page) => page.getWidth() / page.getHeight());
shapes.forEach((shape, index) =>
  assert.ok(Math.abs(shape - sizes[index][0] / sizes[index][1]) < 0.01, `page ${index + 1} shape`),
);
store.close();
console.log('PDF_PAGES_DESKTOP_OK', JSON.stringify({ root, pages: pages.length }));
