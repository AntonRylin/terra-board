// Desktop check for the image editor (filters, adjustments, background removal
// with its install prompt) and filters in the board icon dialog. Everything
// happens in an isolated library.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/image-editor-'));
const store = new Store(root);
const svg = (w, h, body) => Buffer.from(`<svg width="${w}" height="${h}">${body}</svg>`);
const photoBytes = await sharp(
  svg(
    300,
    200,
    '<rect width="300" height="200" fill="#9fc6e8"/><rect y="130" width="300" height="70" fill="#5f9a4d"/><circle cx="150" cy="100" r="50" fill="#e0472f"/>',
  ),
)
  .jpeg({ quality: 95 })
  .toBuffer();
const iconBytes = await sharp(
  svg(
    200,
    200,
    '<rect width="200" height="200" fill="#f6c343"/><circle cx="100" cy="100" r="60" fill="#d8402c"/>',
  ),
)
  .png()
  .toBuffer();
const photo = await store.importAsset({ bytes: photoBytes, name: 'Photo.jpg' });
const iconSource = await store.importAsset({ bytes: iconBytes, name: 'Logo.png' });
const board = store.createBoard({ name: 'Image editor review' });
const object = {
  id: 'photo',
  type: 'image',
  assetId: photo.id,
  text: 'Photo.jpg',
  x: 300,
  y: 250,
  width: 300,
  height: 200,
  z: 1,
  crop: { x: 0.1, y: 0, width: 0.8, height: 1 },
};
store.patchBoard({ id: board.id, revision: 0, upserts: [object], camera: { x: 0, y: 0, zoom: 1 } });
store.updateBoard({ id: board.id, patch: { icon: 'asset-' + iconSource.id, color: 'rose' } });
store.setLastBoard({ id: board.id });
store.close();

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const env = {
  ...process.env,
  CANVAS_DATA_DIR: root,
  TERRA_EXTENSIONS_DIR: join(root, 'Extensions'),
  TERRA_EXTENSIONS_SOURCE: resolve('release/extensions'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const executable = process.env.CANVAS_EXECUTABLE || require('electron');
const child = spawn(
  executable,
  [...(process.env.CANVAS_EXECUTABLE ? [] : ['.']), `--remote-debugging-port=${port}`],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let diagnostics = '',
  socket,
  nextId = 0;
child.stderr.on('data', (b) => (diagnostics += b));
child.stdout.on('data', () => {});
const errors = [],
  pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(60);
  }
  throw Error('Timed out: ' + label);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error('CDP timeout: ' + method));
    }, 60000);
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
const read = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails)
    throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const click = async (x, y, button = 'left') => {
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0,
      clickCount: 1,
    });
};
const clickSelector = async (selector, button = 'left') => {
  const r = await read(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:'nearest',inline:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
  );
  assert.ok(r, selector);
  await click(r.x, r.y, button);
};
const clickText = async (text, container = 'document') => {
  const found = await read(
    `(() => { const b=[...${container}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if (!b) return false; b.dataset.testAction='current'; return true; })()`,
  );
  assert.ok(found, text);
  await clickSelector('[data-test-action="current"]');
  await read(
    `document.querySelector('[data-test-action="current"]')?.removeAttribute('data-test-action')`,
  );
};
const key = async (key, code, modifiers = 0) => {
  const windowsVirtualKeyCode = code.startsWith('Key')
    ? code.charCodeAt(3)
    : { Escape: 27 }[code] || 0;
  for (const type of ['keyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode });
};
const documentState = () =>
  read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
const pixel = async (id, fx = 0.5, fy = 0.5) => {
  const file = join(root, 'assets', id + '.original');
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const i = (Math.floor(info.height * fy) * info.width + Math.floor(info.width * fx)) * 4;
  return {
    r: data[i],
    g: data[i + 1],
    b: data[i + 2],
    a: data[i + 3],
    width: info.width,
    height: info.height,
  };
};
const format = async (id) =>
  (await sharp(join(root, 'assets', id + '.original')).metadata()).format;
const screenshot = async (name) => {
  await sleep(300);
  const shot = await send('Page.captureScreenshot');
  writeFileSync(join(root, name + '.png'), Buffer.from(shot.data, 'base64'));
};
const iconId = () =>
  read(
    `window.canvas.invoke('library').then(l=>l.boards.find(b=>b.id===${JSON.stringify(board.id)}).icon.slice(6))`,
  );
const gray = (p) => Math.abs(p.r - p.g) <= 3 && Math.abs(p.g - p.b) <= 3;

try {
  const target = await until(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === 'page' && t.url.startsWith('canvas-app:'),
      );
    } catch {
      return null;
    }
  }, 'desktop page');
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
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await until(
    () => read(`!!document.querySelector('canvas')&&!document.querySelector('.canvas-loading')`),
    'canvas ready',
  );
  await sleep(400);
  const host = await read(
    `(() => {const r=document.querySelector('.canvas-surface').getBoundingClientRect();return {x:r.x,y:r.y}})()`,
  );
  const center = {
    x: host.x + object.x + object.width / 2,
    y: host.y + object.y + object.height / 2,
  };

  // 1. Selecting an image shows "Edit image"; black & white saves a new JPEG.
  await click(center.x, center.y);
  await until(() => read(`!!document.querySelector('[aria-label="Edit image"]')`), 'edit button');
  await clickSelector('[aria-label="Edit image"]');
  await until(() => read(`!!document.querySelector('.image-editor-preview img')`), 'editor open');
  await clickSelector('.image-filter-choice[title="Black & white"]');
  assert.match(
    await read(`document.querySelector('.image-editor-preview img').style.filter`),
    /grayscale\(1\)/,
  );
  await screenshot('editor-black-and-white');
  await clickText('Save', `document.querySelector('.image-editor-actions')`);
  const edited = await until(async () => {
    const o = (await documentState()).objects[0];
    return o.assetId !== photo.id && o;
  }, 'edited asset saved');
  assert.deepEqual({ ...edited, assetId: photo.id }, object, 'geometry and crop kept');
  assert.equal(await format(edited.assetId), 'jpeg', 'a JPEG stays a JPEG');
  const editedPixel = await pixel(edited.assetId);
  assert.ok(gray(editedPixel), 'center is gray: ' + JSON.stringify(editedPixel));
  assert.equal(editedPixel.width, 300);
  await screenshot('board-black-and-white');

  // 2. Undo brings the original back.
  await key('z', 'KeyZ', 2);
  await until(async () => (await documentState()).objects[0].assetId === photo.id, 'undo');

  // 3. Adjustments alone also save.
  await click(center.x, center.y);
  await clickSelector('[aria-label="Edit image"]');
  await until(
    () => read(`!!document.querySelector('.image-editor-preview img')`),
    'editor reopened',
  );
  await read(`(() => {
    const input = document.querySelectorAll('.image-editor-slider input')[0];
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'150');
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  assert.match(
    await read(`document.querySelector('.image-editor-preview img').style.filter`),
    /brightness\(1\.5\)/,
  );
  await clickText('Cancel', `document.querySelector('.image-editor-actions')`);
  assert.equal((await documentState()).objects[0].assetId, photo.id, 'cancel changes nothing');

  // 4. Remove background without the extension offers to install it, then runs.
  await click(center.x, center.y);
  await clickSelector('[aria-label="Edit image"]');
  await until(() => read(`!!document.querySelector('.image-editor-preview img')`), 'editor again');
  await clickText('Remove background');
  await until(() => read(`!!document.querySelector('.extension-install-card')`), 'install prompt');
  await screenshot('install-prompt');
  await clickText('Not now');
  await until(() => read(`!document.querySelector('.extension-install-card')`), 'prompt dismissed');
  await clickText('Remove background');
  await until(
    () => read(`!!document.querySelector('.extension-install-card')`),
    'install prompt again',
  );
  await clickText('Install');
  await until(
    () =>
      read(
        `[...document.querySelectorAll('.image-editor-action')].some(b=>b.textContent.includes('Restore background'))`,
      ),
    'background removed after install',
    120000,
  );
  await screenshot('editor-cutout');
  await clickSelector('.image-filter-choice[title="Sepia"]');
  await clickText('Save', `document.querySelector('.image-editor-actions')`);
  const cutout = await until(async () => {
    const o = (await documentState()).objects[0];
    return o.assetId !== photo.id && o;
  }, 'cutout saved');
  assert.equal(await format(cutout.assetId), 'png', 'a cutout is saved with transparency');
  assert.ok((await pixel(cutout.assetId, 0.02, 0.02)).a < 20, 'corner is transparent');

  // 5. Board icon: pick black & white for the saved icon.
  await clickSelector(`[data-item="${board.id}"]`, 'right');
  await clickText('Change icon');
  await until(
    () => read(`!!document.querySelector('.board-icon-upload .image-filter-strip')`),
    'icon filters',
  );
  await clickSelector('.board-icon-upload .image-filter-choice[title="Black & white"]');
  await until(
    () =>
      read(`/grayscale/.test(document.querySelector('.board-icon-crop img')?.style.filter || '')`),
    'icon preview filtered',
  );
  await screenshot('icon-black-and-white');
  await clickSelector('.dialog-actions .primary');
  await until(() => read(`!document.querySelector('[role="dialog"]')`), 'icon saved');
  const icon = await iconId();
  assert.notEqual(icon, iconSource.id);
  assert.ok(gray(await pixel(icon)), 'icon is gray');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, artifacts: root }));
} catch (error) {
  console.error(error, diagnostics.slice(-3000));
  if (socket?.readyState === 1) await screenshot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
