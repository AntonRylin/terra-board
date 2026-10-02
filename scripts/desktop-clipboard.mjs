// Verify native image copy and editable round trips using an independent clipboard consumer.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer, createConnection } from 'node:net';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/clipboard-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Original image' });
const pixels = Buffer.alloc(4096 * 2048 * 4);
for (let i = 0; i < pixels.length; i += 4) {
  pixels[i] = (i / 4) % 2 ? 250 : 10;
  pixels[i + 1] = 80;
  pixels[i + 2] = 170;
  pixels[i + 3] = (i / 4) % 4 === 0 ? 128 : 255;
}
const bytes = await sharp(pixels, { raw: { width: 4096, height: 2048, channels: 4 } })
  .png()
  .toBuffer();
const asset = await store.importAsset({ bytes, name: 'Full quality.png' });
const original = {
  id: 'source',
  type: 'image',
  assetId: asset.id,
  x: 100,
  y: 100,
  width: 480,
  height: 240,
  z: 1,
  imageTitle: 'Preserve title',
  text: 'Full quality.png',
};
store.patchBoard({
  id: board.id,
  revision: 0,
  upserts: [original],
  deleted: [],
  camera: { x: 0, y: 0, zoom: 1 },
});
const croppedBoard = store.createBoard({ name: 'Cropped image' });
const cropped = {
  ...original,
  id: 'cropped',
  crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
  rotation: 90,
};
store.patchBoard({
  id: croppedBoard.id,
  revision: 0,
  upserts: [cropped],
  deleted: [],
  camera: { x: 0, y: 0, zoom: 1 },
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
const probe = spawn(require('electron'), [resolve('scripts/clipboard-probe.cjs'), root], {
  env,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let probeId = 0;
const probePending = new Map();
let probeReady;
const ready = new Promise((resolve) => {
  probeReady = resolve;
});
const probeLine = (line) => {
  if (!line.startsWith('{')) return;
  const message = JSON.parse(line);
  if (message.id === 0) {
    probeReady(message.result);
    return;
  }
  const pending = probePending.get(message.id);
  probePending.delete(message.id);
  message.error ? pending?.reject(Error(message.error)) : pending?.resolve(message.result);
};
createInterface({ input: probe.stdout }).on('line', probeLine);
let probeConnection;
probe.stderr.on('data', (b) => {
  diagnostics += b;
});
const probeCall = (command) =>
  new Promise((resolve, reject) => {
    const id = ++probeId;
    const timer = setTimeout(() => reject(Error('Clipboard probe timeout: ' + command)), 15000);
    probePending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    probeConnection.write(JSON.stringify({ id, command }) + '\n');
  });
const hash = (data) => createHash('sha256').update(data).digest('hex');
try {
  const probePort = await ready;
  probeConnection = createConnection({ host: '127.0.0.1', port: probePort });
  await new Promise((resolve) => probeConnection.once('connect', resolve));
  createInterface({ input: probeConnection }).on('line', probeLine);
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
  await probeCall('clear');
  const pointerAtPaste = { x: 750, y: 420 };
  await mouse('mouseMoved', pointerAtPaste.x, pointerAtPaste.y);
  await key('a', 'KeyA', 2);
  await key('c', 'KeyC', 2);
  await key('v', 'KeyV', 2);
  await mouse('mouseMoved', pointerAtPaste.x + 130, pointerAtPaste.y + 90);
  const copied = await until(async () => {
    const result = await probeCall('read');
    return result.image ? result : null;
  }, 'image available to another process');
  assert.equal(copied.image.width, 4096);
  assert.equal(copied.image.height, 2048);
  assert.deepEqual(copied.fileImage, { width: 4096, height: 2048, hash: hash(pixels) });
  assert.equal(copied.objects[0].imageTitle, original.imageTitle);
  assert.deepEqual(
    await probeCall('paste'),
    copied.fileImage,
    'another app receives original pixels',
  );
  const roundTrip = await until(async () => {
    const doc = await read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
    return doc.objects.length === 2 ? doc.objects.find((o) => o.id !== original.id) : null;
  }, 'editable image pasted back into Terra');
  assert.equal(roundTrip.assetId, asset.id);
  assert.equal(roundTrip.width, 480);
  assert.equal(roundTrip.imageTitle, original.imageTitle);
  const surface = await rect('.canvas-surface');
  assert.equal(
    roundTrip.x + roundTrip.width / 2,
    pointerAtPaste.x - surface.x,
    'pending copy keeps paste-time cursor x',
  );
  assert.equal(
    roundTrip.y + roundTrip.height / 2,
    pointerAtPaste.y - surface.y,
    'pending copy keeps paste-time cursor y',
  );
  await clickSelector('[aria-label="Open board Cropped image"]');
  await until(
    () =>
      read(
        `document.querySelector('.board-name')?.textContent?.includes('Cropped image') || document.body.innerText.includes('Cropped image')`,
      ),
    'cropped board',
  );
  await probeCall('clear');
  await click(340, 220, 'right');
  const item = await until(
    () =>
      read(
        `(() => { const b=[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.trim()==='Copy as image'); if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
      ),
    'Copy as image menu',
  );
  await click(item.x, item.y);
  const croppedCopy = await until(async () => {
    const result = await probeCall('read');
    return result.image ? result : null;
  }, 'cropped image copied');
  const cropPixels = await sharp(bytes)
    .extract({ left: 1024, top: 512, width: 2048, height: 1024 })
    .rotate(90)
    .raw()
    .toBuffer();
  assert.deepEqual(croppedCopy.fileImage, { width: 1024, height: 2048, hash: hash(cropPixels) });
  assert.deepEqual(await probeCall('paste'), croppedCopy.fileImage);
  await key('v', 'KeyV', 2);
  const cropRoundTrip = await until(async () => {
    const doc = await read(
      `window.canvas.invoke('loadBoard',{id:${JSON.stringify(croppedBoard.id)}})`,
    );
    return doc.objects.length === 2 ? doc.objects.find((o) => o.id !== cropped.id) : null;
  }, 'cropped object round trip');
  assert.deepEqual(cropRoundTrip.crop, cropped.crop);
  assert.equal(cropRoundTrip.rotation, 90);
  const originalButton = await rect('[aria-label="Open board Original image"]');
  await key('x', 'KeyX', 2);
  await click(
    originalButton.x + originalButton.width / 2,
    originalButton.y + originalButton.height / 2,
  );
  await until(
    () => read('document.querySelector(".board-title")?.textContent === "Original image"'),
    'switch during image cut',
  );
  await until(async () => {
    const doc = await read(
      `window.canvas.invoke('loadBoard',{id:${JSON.stringify(croppedBoard.id)}})`,
    );
    return doc.objects.length === 1;
  }, 'cut after successful image copy');
  await clickSelector('[aria-label="Open board Cropped image"]');
  await until(
    () => read('document.querySelector(".board-title")?.textContent === "Cropped image"'),
    'return to cut source',
  );
  await key('v', 'KeyV', 2);
  await until(async () => {
    const doc = await read(
      `window.canvas.invoke('loadBoard',{id:${JSON.stringify(croppedBoard.id)}})`,
    );
    return doc.objects.length === 2;
  }, 'cut image pasted back');
  await key('a', 'KeyA', 2);
  await key('c', 'KeyC', 2);
  await key('v', 'KeyV', 2);
  await until(async () => {
    const doc = await read(
      `window.canvas.invoke('loadBoard',{id:${JSON.stringify(croppedBoard.id)}})`,
    );
    return doc.objects.length === 4;
  }, 'multiple-object clipboard preserved');
  // Normal text selection uses the OS clipboard rather than copying canvas objects.
  await key('k', 'KeyK', 2);
  await until(() => read('!!document.querySelector("[role=dialog] input")'), 'search input');
  await send('Input.insertText', { text: 'Normal text copy' });
  await key('a', 'KeyA', 2);
  await key('c', 'KeyC', 2);
  await until(
    async () => (await probeCall('read')).text === 'Normal text copy',
    'text copy unchanged',
  );
  await key('Escape', 'Escape');
  await read(`window.canvas.copyObjects(${JSON.stringify([original])})`);
  await probeCall('image-only');
  await read(`document.querySelector('.canvas-surface').focus()`);
  const nativePoint = { x: 690, y: 510 };
  await mouse('mouseMoved', nativePoint.x, nativePoint.y);
  const beforeNative = await read(
    `window.canvas.invoke('loadBoard',{id:${JSON.stringify(croppedBoard.id)}})`,
  );
  await key('v', 'KeyV', 2);
  await mouse('mouseMoved', nativePoint.x + 150, nativePoint.y + 100);
  const nativeImage = await until(async () => {
    const d = await read(
      `window.canvas.invoke('loadBoard',{id:${JSON.stringify(croppedBoard.id)}})`,
    );
    return d.objects.length === beforeNative.objects.length + 1
      ? d.objects.find((o) => !beforeNative.objects.some((old) => old.id === o.id))
      : null;
  }, 'native image pasted at cursor');
  assert.ok(
    Math.abs(
      (nativeImage.x + nativeImage.width / 2) * beforeNative.camera.zoom +
        beforeNative.camera.x +
        surface.x -
        nativePoint.x,
    ) < 0.01,
  );
  assert.ok(
    Math.abs(
      (nativeImage.y + nativeImage.height / 2) * beforeNative.camera.zoom +
        beforeNative.camera.y +
        surface.y -
        nativePoint.y,
    ) < 0.01,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks:
        'Ctrl+C, native clipboard pixels, paste in another process, Copy as image, crop/rotation, editable round trips, ordinary text copy, internal and external images at paste-time cursor',
      artifacts: root,
    }),
  );
} catch (error) {
  console.error(error, diagnostics);
  console.error(await read('document.body.innerText'));
  console.error(
    await read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(croppedBoard.id)}})`),
  );
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
  probeConnection?.end();
  await new Promise((resolve) => probe.once('exit', resolve));
}
