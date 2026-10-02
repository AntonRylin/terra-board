// Gallery layout, naming, drag, clipboard and persistence through real desktop input.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/gallery-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Gallery test' });
const other = store.createBoard({ name: 'Other board' });
const sharp = require('sharp');
const imageBytes = await sharp({
  create: { width: 800, height: 450, channels: 3, background: '#648e91' },
})
  .png()
  .toBuffer();
const asset = await store.importAsset({ bytes: imageBytes, name: 'Landscape.png' });
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
  const documentState = () =>
    read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
  const saved = async (test, label) =>
    until(async () => {
      const d = await documentState();
      return test(d) ? d : null;
    }, label);
  const galleryOf = (d) => d.objects.find((o) => o.gallery);
  const membersOf = (d, g = galleryOf(d)) =>
    d.objects.filter((o) => o.galleryId === g.id).sort((a, b) => a.galleryIndex - b.galleryIndex);
  const menuItem = async (label) => {
    const p = await until(
      () =>
        read(
          `(()=>{const el=[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.trim()===${JSON.stringify(label)});if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        ),
      label,
    );
    await click(p.x, p.y);
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(root, name + '.png'), Buffer.from(s.data, 'base64'));
  };
  const point = async (o, dx = 20, dy = -16) => {
    const zoom = await read('parseFloat(document.querySelector(".zoom-value").textContent)');
    const c = await until(async () => {
      const c = (await documentState()).camera;
      return Math.round(c.zoom * 100) === zoom ? c : null;
    }, 'camera saved');
    const r = await rect('.canvas-surface');
    return { x: r.x + (o.x + dx) * c.zoom + c.x, y: r.y + (o.y + dy) * c.zoom + c.y };
  };
  const copySource = async (i = 0) =>
    read(
      `window.canvas.copyObjects(${JSON.stringify([{ id: 'clipboard-source', type: 'image', assetId: asset.id, text: 'Landscape.png', x: 0, y: 0, width: i === 1 ? 225 : 400, height: i === 1 ? 400 : 225, z: 1 }])})`,
    );
  await clickSelector('[aria-label="Insert"]');
  await menuItem('Gallery');
  let d = await saved((d) => !!galleryOf(d), 'gallery created');
  let g = galleryOf(d);
  await until(() => read('!!document.querySelector(".gallery-empty")'), 'empty hint');
  await shot('empty');
  let p = await point(g);
  await click(p.x, p.y);
  await until(
    () => read(`!!document.querySelector('[aria-label="Edit gallery name"]')`),
    'name editor',
  );
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Vehicle references' });
  await key('Enter', 'Enter');
  d = await saved((d) => galleryOf(d)?.text === 'Vehicle references', 'gallery renamed');
  for (let i = 0; i < 3; i++) {
    await copySource(i);
    await key('v', 'KeyV', 2);
    d = await saved((d) => membersOf(d).length === i + 1, 'image appended ' + i);
    assert.ok(
      await read(`!!document.querySelector('[aria-label="Gallery layout"]')`),
      'gallery stays selected',
    );
  }
  let images = membersOf(d);
  g = galleryOf(d);
  assert.ok(images.every((o) => o.width === 400));
  for (let i = 1; i < images.length; i++)
    assert.equal(images[i].y, images[i - 1].y + images[i - 1].height + 12);
  await clickSelector('[aria-label="Fit board"]');
  await sleep(200);
  await shot('column');
  await clickSelector('.gallery-controls button:first-child');
  d = await saved((d) => galleryOf(d).gallery.direction === 'right', 'right layout');
  images = membersOf(d);
  g = galleryOf(d);
  assert.ok(images.every((o) => o.height === 400));
  for (let i = 1; i < images.length; i++)
    assert.equal(images[i].x, images[i - 1].x + images[i - 1].width + 12);
  await clickSelector('[aria-label="Fit board"]');
  await sleep(200);
  await shot('row');
  g = galleryOf(await documentState());
  const resizePoint = await point(g, g.width / 2, g.height);
  await mouse('mousePressed', resizePoint.x, resizePoint.y);
  await mouse('mouseMoved', resizePoint.x, resizePoint.y - 40);
  await mouse('mouseReleased', resizePoint.x, resizePoint.y - 40);
  d = await saved((d) => galleryOf(d).gallery.size < 400, 'resize gallery');
  assert.ok(
    membersOf(d).every((o) => Math.abs(o.height - galleryOf(d).gallery.size) < 0.01),
    'resize scales every image',
  );
  await key('z', 'KeyZ', 2);
  d = await saved((d) => galleryOf(d).gallery.size === 400, 'undo gallery resize');
  await key('z', 'KeyZ', 2);
  d = await saved((d) => galleryOf(d).gallery.direction === 'below', 'undo direction');
  await key('y', 'KeyY', 2);
  d = await saved((d) => galleryOf(d).gallery.direction === 'right', 'redo direction');
  g = galleryOf(d);
  images = membersOf(d);
  p = await point(g);
  await mouse('mousePressed', p.x, p.y);
  await mouse('mouseMoved', p.x + 65, p.y + 50);
  await mouse('mouseReleased', p.x + 65, p.y + 50);
  let moved = await saved((d) => galleryOf(d).x !== g.x, 'drag gallery name');
  const mg = galleryOf(moved),
    mi = membersOf(moved);
  for (let i = 0; i < images.length; i++) {
    assert.ok(Math.abs(mi[i].x - images[i].x - (mg.x - g.x)) < 0.01, 'image follows x');
    assert.ok(Math.abs(mi[i].y - images[i].y - (mg.y - g.y)) < 0.01, 'image follows y');
  }
  assert.equal(
    await read('!!document.querySelector("textarea.text-editor")'),
    false,
    'drag does not rename',
  );
  await key('z', 'KeyZ', 2);
  d = await saved((d) => Math.abs(galleryOf(d).x - g.x) < 0.01, 'undo gallery move');
  const mixed = [
    {
      id: 'mixed-image',
      type: 'image',
      assetId: asset.id,
      x: 0,
      y: 0,
      width: 400,
      height: 225,
      z: 1,
    },
    {
      id: 'mixed-text',
      type: 'text',
      text: 'A note beside the gallery',
      x: 0,
      y: 0,
      width: 250,
      height: 40,
      z: 2,
    },
  ];
  await read(`window.canvas.copyObjects(${JSON.stringify(mixed)})`);
  await key('v', 'KeyV', 2);
  d = await saved((d) => d.objects.length === 6, 'mixed selection pasted');
  assert.equal(membersOf(d).length, 4, 'mixed images attach');
  assert.ok(!d.objects.find((o) => o.type === 'text').galleryId, 'text remains outside');
  await key('z', 'KeyZ', 2);
  d = await saved((d) => d.objects.length === 4, 'undo mixed paste');
  await key('c', 'KeyC', 2);
  await key('v', 'KeyV', 2);
  d = await saved((d) => d.objects.filter((o) => o.gallery).length === 2, 'copy entire gallery');
  const clone = d.objects.find((o) => o.gallery && o.id !== g.id);
  assert.equal(membersOf(d, clone).length, 3);
  assert.equal(clone.text, 'Vehicle references');
  await key('Delete', 'Delete');
  d = await saved((d) => d.objects.length === 4, 'delete gallery and members');
  await key('z', 'KeyZ', 2);
  d = await saved((d) => d.objects.length === 8, 'undo gallery deletion');
  await key('z', 'KeyZ', 2);
  d = await saved((d) => d.objects.length === 4, 'undo gallery paste');
  await key('Escape', 'Escape');
  await copySource();
  await key('v', 'KeyV', 2);
  d = await saved((d) => d.objects.length === 5, 'ordinary paste outside gallery');
  assert.equal(d.objects.filter((o) => o.type === 'image' && !o.galleryId).length, 1);
  await clickSelector('[aria-label="Open board Other board"]');
  await until(
    () => read('document.querySelector(".board-title")?.textContent === "Other board"'),
    'other board',
  );
  await clickSelector('[aria-label="Open board Gallery test"]');
  await until(
    () => read('document.querySelector(".board-title")?.textContent === "Gallery test"'),
    'gallery board reopened',
  );
  d = await documentState();
  assert.equal(galleryOf(d).text, 'Vehicle references');
  assert.equal(membersOf(d).length, 3);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks:
        'Insert, empty hint, rename, repeated native clipboard paste, row/column, aspect ratio, drag by name, undo/redo, copy/delete whole gallery, ordinary paste, board reopening',
      artifacts: root,
    }),
  );
} catch (error) {
  console.error(error, diagnostics);
  console.error(await read('document.body.innerText'));
  const fail = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, 'failure.png'), Buffer.from(fail.data, 'base64'));
  console.error(root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
