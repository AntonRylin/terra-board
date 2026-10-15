// Copying text out of images and PDFs in the packaged app: Windows text
// recognition on an image and a scanned PDF, the PDF's own text otherwise,
// selected with real mouse drags and copied with Ctrl+C or the copy buttons.
// Uses an isolated repository-local library; never touches the user's boards.
// Restores the clipboard's previous text when done.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const sharp = require('sharp');
const { PDFDocument, StandardFonts } = require('pdf-lib');

mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-text-recognition-'));
const lines = [
  'Quarterly report: revenue grew 12% in Q3.',
  'Привет, это тестовый документ для OCR.',
  'Mixed: Terra Board поддерживает copy text.',
];
const png = await sharp(
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300">
  <rect width="100%" height="100%" fill="#fff"/>
  ${lines.map((line, i) => `<text x="30" y="${70 + i * 70}" font-family="Segoe UI" font-size="32" fill="#222">${line}</text>`).join('')}
</svg>`),
)
  .png()
  .toBuffer();
const textPdf = await PDFDocument.create();
{
  const page = textPdf.addPage([612, 792]);
  const font = await textPdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Invoice number 4821', { x: 72, y: 700, size: 24, font });
  page.drawText('Total due: 380 EUR by March', { x: 72, y: 660, size: 18, font });
}
const scanPdf = await PDFDocument.create();
{
  const image = await scanPdf.embedPng(png);
  const page = scanPdf.addPage([900, 300]);
  page.drawImage(image, { x: 0, y: 0, width: 900, height: 300 });
}

const store = new Store(root);
const board = store.createBoard({ name: 'Text recognition' });
store.setLastBoard({ id: board.id });
store.saveCamera({ id: board.id, camera: { x: 0, y: 0, zoom: 1 } });
const imageAsset = await store.importAsset({ name: 'Report.png', bytes: png });
const textAsset = await store.importAsset({
  name: 'Invoice.pdf',
  bytes: Buffer.from(await textPdf.save()),
});
const scanAsset = await store.importAsset({
  name: 'Scan.pdf',
  bytes: Buffer.from(await scanPdf.save()),
});
const document = (id, asset, name, x) => ({
  id,
  type: 'document',
  x,
  y: 420,
  width: 320,
  height: 300,
  z: 2,
  text: name,
  assetId: asset.id,
  documentMime: 'application/pdf',
});
store.patchBoard({
  id: board.id,
  revision: store.loadBoard({ id: board.id }).revision,
  deleted: [],
  upserts: [
    {
      id: 'image',
      type: 'image',
      x: 60,
      y: 60,
      width: 600,
      height: 200,
      z: 1,
      assetId: imageAsset.id,
      crop: { x: 0, y: 0, width: 1, height: 0.5 },
    },
    document('invoice', textAsset, 'Invoice.pdf', 60),
    document('scan', scanAsset, 'Scan.pdf', 420),
  ],
});
store.close();

const clipboard = {
  read: () =>
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-Clipboard -Raw',
      ],
      { encoding: 'utf8' },
    )
      .stdout.replace(/\r\n/g, '\n')
      .replace(/\n$/, ''),
  write: (text) =>
    spawnSync('powershell.exe', ['-NoProfile', '-Command', '$input | Set-Clipboard'], {
      input: text,
      encoding: 'utf8',
    }),
};
const savedClipboard = clipboard.read();

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const env = { ...process.env, CANVAS_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
// TERRA_SOURCE_APP=1 runs the built dist through the repository's Electron instead.
const fromSource = !!process.env.TERRA_SOURCE_APP;
const child = spawn(
  fromSource
    ? require('electron')
    : resolve(process.env.CANVAS_EXECUTABLE || 'release/win-unpacked/Terra Board.exe'),
  [
    ...(fromSource ? [resolve('.')] : []),
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
    await sleep(80);
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
async function mouse(type, x, y, buttons = 0, clickCount = 1, button = 'left') {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' && !buttons ? 'none' : button,
    buttons,
    clickCount,
  });
}
async function clickAt(x, y, count = 1, button = 'left') {
  await mouse('mouseMoved', x, y);
  for (let i = 1; i <= count; i++) {
    await mouse('mousePressed', x, y, button === 'left' ? 1 : 2, i, button);
    await mouse('mouseReleased', x, y, 0, i, button);
  }
}
async function drag(from, to) {
  await mouse('mouseMoved', from.x, from.y);
  await mouse('mousePressed', from.x, from.y, 1);
  for (let step = 1; step <= 10; step++)
    await mouse(
      'mouseMoved',
      from.x + ((to.x - from.x) * step) / 10,
      from.y + ((to.y - from.y) * step) / 10,
      1,
    );
  await mouse('mouseReleased', to.x, to.y, 0);
}
async function click(selector) {
  const r = await until(() => rect(selector), selector);
  await clickAt(r.x + r.width / 2, r.y + r.height / 2);
}
const pressCopy = async () => {
  for (const type of ['keyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', {
      type,
      key: 'c',
      code: 'KeyC',
      modifiers: 2,
      windowsVirtualKeyCode: 67,
      ...(type === 'keyDown' ? { commands: ['copy'] } : {}),
    });
};
const pressKey = async (key, code, modifiers = 0, vk) => {
  for (const type of ['keyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode: vk });
};
const screenshot = async (name) =>
  writeFileSync(
    join(root, name),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
// Screen centre of a board object (camera at the origin, zoom 1).
const objectCenter = async (id) => {
  const host = await rect('.canvas-surface');
  const o = (
    await read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`)
  ).objects.find((item) => item.id === id);
  return { x: host.x + o.x + o.width / 2, y: host.y + o.y + o.height / 2 };
};
const menu = async (id, label) => {
  const point = await objectCenter(id);
  await clickAt(point.x, point.y);
  await clickAt(point.x, point.y, 1, 'right');
  const item = await until(
    () =>
      read(
        `(()=>{const b=[...document.querySelectorAll('.context-menu [role=menuitem]')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      ),
    'menu item ' + label,
  );
  await clickAt(item.x, item.y);
};
const clipboardHas = (expected, label) =>
  until(() => clipboard.read() === expected && expected, label, 30000).catch(() => {
    throw Error(`${label}: clipboard was ${JSON.stringify(clipboard.read())}`);
  });
// Drag from the first character of one recognized word to the last of another.
const words = (scope) =>
  read(
    `[...document.querySelectorAll(${JSON.stringify(scope + ' .text-layer-word')})].map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent,x:r.x,y:r.y,width:r.width,height:r.height}})`,
  );
async function selectWords(scope, first, last) {
  const list = await words(scope);
  const from = list.find((w) => w.text === first),
    to = list.find((w) => w.text === last);
  assert.ok(from && to, `words ${first} and ${last} in ${JSON.stringify(list.map((w) => w.text))}`);
  await drag(
    { x: from.x + 1, y: from.y + from.height / 2 },
    { x: to.x + to.width - 1, y: to.y + to.height / 2 },
  );
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
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await until(
    () =>
      read(
        `!!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading') && !document.getElementById('startup-screen')`,
      ),
    'board',
    40000,
  );
  await sleep(800);

  // 1. The main process reads mixed English and Russian text.
  const recognized = await read(
    `window.canvas.recognizeAsset(${JSON.stringify(imageAsset.id)}).then(t=>t.lines.map(l=>l.words.map(w=>w.text).join(' ')))`,
  );
  assert.deepEqual(recognized, lines);
  console.log('recognized image lines');

  // 2. Full image preview: drag-select across two lines and copy with Ctrl+C.
  const imagePoint = await objectCenter('image');
  await clickAt(imagePoint.x, imagePoint.y, 2);
  await until(
    () => read(`document.querySelectorAll('.image-viewer .text-layer-line').length === 3`),
    'image text layer',
  );
  await selectWords('.image-viewer', 'Quarterly', 'для');
  const selected = await read('getSelection().toString()');
  assert.match(selected, /Quarterly/);
  await screenshot('image-selection.png');
  await pressCopy();
  await clipboardHas(
    'Quarterly report: revenue grew 12% in Q3.\nПривет, это тестовый документ для',
    'Ctrl+C on a selection in the image preview',
  );
  console.log('copied an image selection with Ctrl+C');
  // Pan still works when the drag starts outside the text.
  const stage = await rect('.image-viewer-stage');
  await clickAt(stage.x + 10, stage.y + stage.height - 10);
  assert.equal(await read('getSelection().toString()'), '');
  // Copy button: whole text; Ctrl+A selects all of it.
  await click('.image-viewer-copy-text');
  await clipboardHas(lines.join('\n'), 'image Copy text button');
  await pressKey('a', 'KeyA', 2, 65);
  assert.match(await read('getSelection().toString()'), /Mixed: Terra Board/);
  console.log('copied all image text');
  await pressKey('Escape', 'Escape', 0, 27);
  await until(() => read(`!document.querySelector('.image-viewer')`), 'image viewer closed');

  // 3. Board context menu: only the cropped (top) half of the image is copied.
  await menu('image', 'Copy text');
  await clipboardHas(lines.slice(0, 2).join('\n'), 'board Copy text on a cropped image');
  console.log('copied text from the board menu');

  // 4. A PDF with its own text: selection in the full preview.
  await menu('invoice', 'Full PDF preview');
  await until(
    () =>
      read(
        `[...document.querySelectorAll('.pdf-workspace .text-layer-word')].some(e=>e.textContent.includes('4821'))`,
      ),
    'PDF text layer',
  );
  await selectWords('.pdf-workspace', 'Total due: 380 EUR by March', 'Total due: 380 EUR by March');
  await pressCopy();
  await clipboardHas('Total due: 380 EUR by March', 'Ctrl+C in the PDF preview');
  await click('.pdf-copy-text');
  await clipboardHas('Invoice number 4821\nTotal due: 380 EUR by March', 'PDF Copy page text');
  console.log('copied PDF text');
  await pressKey('Escape', 'Escape', 0, 27);
  await until(() => read(`!document.querySelector('.pdf-workspace')`), 'PDF preview closed');

  // 5. A scanned PDF has no text of its own; recognition fills the layer.
  await menu('scan', 'Full PDF preview');
  await until(
    () => read(`document.querySelectorAll('.pdf-workspace .text-layer-line').length === 3`),
    'scanned PDF text layer',
    40000,
  );
  await screenshot('scan-preview.png');
  await selectWords('.pdf-workspace', 'Привет,', 'OCR.');
  await pressCopy();
  await clipboardHas('Привет, это тестовый документ для OCR.', 'Ctrl+C in a scanned PDF');
  console.log('copied scanned PDF text');
  await pressKey('Escape', 'Escape', 0, 27);
  await until(() => read(`!document.querySelector('.pdf-workspace')`), 'scan preview closed');

  // 6. The board's inline PDF reader also has selectable text, and Ctrl+C copies
  // the text rather than the selected board object.
  const scanPoint = await objectCenter('invoice');
  await clickAt(scanPoint.x, scanPoint.y, 2);
  await until(
    () => read(`document.querySelectorAll('.document-reader .text-layer-line').length >= 2`),
    'inline reader text',
  );
  await selectWords('.document-reader', 'Invoice number 4821', 'Invoice number 4821');
  await pressCopy();
  await clipboardHas('Invoice number 4821', 'Ctrl+C in the inline reader');
  console.log('copied text in the inline reader');

  // 7. Board menu on a scanned PDF copies every page's recognized text.
  await pressKey('Escape', 'Escape', 0, 27);
  await menu('scan', 'Copy text');
  await clipboardHas(lines.join('\n'), 'board Copy text on a scanned PDF');
  console.log('copied scanned PDF text from the board menu');

  assert.deepEqual(errors, []);
  console.log('Text recognition checks passed. Library:', root);
} catch (error) {
  console.error(error);
  if (socket) {
    try {
      await screenshot('failure.png');
    } catch {}
  }
  console.error('Library:', root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
  clipboard.write(savedClipboard);
}
