import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-frame-links-'));
const store = new Store(root);
const sourceBoard = store.createBoard({ name: 'Process A board' });
const board = store.createBoard({ name: 'Process B board' });
const sourceImage = await store.importAsset({
  name: 'source-image.png',
  bytes: await sharp({
    create: { width: 80, height: 80, channels: 4, background: '#3050e0' },
  })
    .png()
    .toBuffer(),
});
const sourceFrame = {
  id: 'process-a',
  type: 'frame',
  x: 0,
  y: 0,
  width: 300,
  height: 200,
  z: 0,
  text: 'Process A',
};
const sourceRect = {
  id: 'step',
  type: 'rect',
  x: 40,
  y: 50,
  width: 90,
  height: 60,
  z: 1,
  color: '#e02030',
};
store.patchBoard({
  id: sourceBoard.id,
  revision: 0,
  upserts: [
    sourceFrame,
    sourceRect,
    {
      id: 'image',
      type: 'image',
      assetId: sourceImage.id,
      x: 170,
      y: 50,
      width: 60,
      height: 60,
      z: 3,
    },
    {
      id: 'label',
      type: 'text',
      x: 40,
      y: 125,
      width: 220,
      height: 50,
      z: 2,
      text: 'Reusable step',
      fontSize: 20,
    },
  ],
  deleted: [],
  camera: { x: 180, y: 180, zoom: 1 },
});
store.setLastBoard({ id: sourceBoard.id });
store.close();
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const env = { ...process.env, CANVAS_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const source = !!process.env.TERRA_SOURCE_CHECK;
const harness = join(root, 'export-main.cjs');
if (source)
  writeFileSync(
    harness,
    `
const { dialog } = require('electron');
const path = require('node:path');
dialog.showSaveDialog = async (_win, options) => ({ canceled: false, filePath: path.join(process.env.CANVAS_DATA_DIR, options.defaultPath) });
require(${JSON.stringify(resolve('electron/main.cjs'))});
`,
  );
const child = spawn(
  source
    ? require('electron')
    : resolve(process.env.TERRA_TEST_EXE || 'release/win-unpacked/Terra Board.exe'),
  [...(source ? [harness] : []), `--remote-debugging-port=${port}`],
  { env, windowsHide: true, stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(60);
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
async function mouse(type, x, y, buttons = 0, modifiers = 0) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
    buttons,
    clickCount: 1,
    modifiers,
  });
}
async function click(selector) {
  let previous;
  const r = await until(async () => {
    const next = await rect(selector);
    const stable = next && JSON.stringify(next) === JSON.stringify(previous);
    previous = next;
    return stable ? next : null;
  }, selector);
  const x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, 1);
  await mouse('mouseReleased', x, y);
}
const key = async (key, code = key, modifiers = 0) => {
  const windowsVirtualKeyCode =
    { Tab: 9, Enter: 13, Escape: 27, ArrowLeft: 37 }[key] || key.toUpperCase().charCodeAt(0);
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
const state = () => read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
const screenshot = async (name) =>
  writeFileSync(
    join(root, name),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
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
  await until(
    () =>
      read(
        "!document.querySelector('#startup-screen') && !!document.querySelector('.canvas-toolbar')",
      ),
    'ready',
  );
  const surface = await rect('.canvas-surface');
  const clickAt = async (x, y, count = 1) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: count,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: count,
    });
  };
  const worldClick = async (id, x, y, count = 1) => {
    const d = await read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(id)}})`);
    await clickAt(
      surface.x + d.camera.x + x * d.camera.zoom,
      surface.y + d.camera.y + y * d.camera.zoom,
      count,
    );
  };
  await worldClick(sourceBoard.id, 150, 5);
  await click('[aria-label="Copy frame link"]');
  await until(
    () => read('window.canvas.clipboardObjects().then(o=>o?.[0]?.frameLink)'),
    'frame reference copied',
  );
  await click('[aria-label="Open board Process B board"]');
  await until(
    () =>
      read(
        "!!document.querySelector('.canvas-surface canvas') && document.body.innerText.includes('Room for your next idea')",
      ),
    'destination ready',
  );
  const centers = [220, 550, 880].map((x) => ({ x: surface.x + x, y: surface.y + 330 }));
  for (const [index, p] of centers.entries()) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...p,
      button: 'right',
      buttons: 2,
      clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...p,
      button: 'right',
      buttons: 0,
      clickCount: 1,
    });
    await until(
      () =>
        read(
          "[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='Paste linked frame')",
        ),
      'paste menu',
    );
    await read(
      "[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent==='Paste linked frame').click()",
    );
    await until(async () => (await state()).objects.length === index + 1, 'saved reference');
  }
  const instances = (await state()).objects;
  assert.equal(instances.length, 3);
  assert.ok(
    instances.every(
      (o) => o.frameLink.frameId === sourceFrame.id && o.frameLink.boardId === sourceBoard.id,
    ),
  );
  const pixelColors = async () => {
    const png = Buffer.from(
      (await send('Page.captureScreenshot', { format: 'png' })).data,
      'base64',
    );
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const viewport = await read('({width:innerWidth,height:innerHeight})');
    return instances.map((o) => {
      const x = Math.round(((surface.x + o.x + 80) * info.width) / viewport.width);
      const y = Math.round(((surface.y + o.y + 80) * info.height) / viewport.height);
      return [
        ...data.subarray(
          (y * info.width + x) * info.channels,
          (y * info.width + x) * info.channels + 3,
        ),
      ];
    });
  };
  await until(
    async () => (await pixelColors()).every(([r, g, b]) => r > 180 && g < 80 && b < 100),
    'all three previews render red source',
  );
  await screenshot('three-live-frames.png');
  const first = instances[0];
  await worldClick(board.id, first.x + 80, first.y + 80);
  await key('F2');
  assert.equal(
    await read("!!document.querySelector('textarea')"),
    false,
    'source body stays read-only',
  );
  await worldClick(board.id, first.x + 80, first.y + 80, 2);
  await until(
    () =>
      read(
        '!!document.querySelector(\'[aria-label="Copy frame link"]\') && !document.querySelector(\'[aria-label="Open original frame"]\')',
      ),
    'double click opens original',
  );
  await until(
    async () =>
      (await read(`window.canvas.invoke('loadBoard',{id:'${sourceBoard.id}'})`)).camera.zoom ===
      1.5,
    'original focused',
  );
  await worldClick(sourceBoard.id, 80, 80);
  await click('[aria-label="Set color #e4eee8"]');
  await until(
    async () =>
      (await read(`window.canvas.invoke('loadBoard',{id:'${sourceBoard.id}'})`)).objects.find(
        (o) => o.id === 'step',
      ).color === '#e4eee8',
    'source edited',
  );
  await worldClick(sourceBoard.id, 20, -18);
  await until(
    () => read('!!document.querySelector(\'[aria-label="Edit frame name"]\')'),
    'source title editor',
  );
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Process A updated' });
  await key('Enter');
  await click('[aria-label="Open board Process B board"]');
  await until(
    async () =>
      (await pixelColors()).every(
        ([r, g, b]) => Math.abs(r - 228) < 5 && Math.abs(g - 238) < 5 && Math.abs(b - 232) < 5,
      ),
    'all instances reflect source edit',
  );
  await screenshot('three-updated-frames.png');
  // An external edit of a closed source board must refresh the open destination.
  await read(
    `(async()=>{const d=await window.canvas.invoke('loadBoard',{id:'${sourceBoard.id}'});await window.canvas.invoke('patchBoard',{id:d.board.id,revision:d.revision,upserts:[{...d.objects.find(o=>o.id==='step'),color:'#e02030'}],deleted:[]})})()`,
  );
  await until(
    async () => (await pixelColors()).every(([r, g, b]) => r > 180 && g < 80 && b < 100),
    'closed-board external update',
  );
  // Deletion and restoration reconnect without modifying destination objects.
  await read(
    `(async()=>{const d=await window.canvas.invoke('loadBoard',{id:'${sourceBoard.id}'});await window.canvas.invoke('patchBoard',{id:d.board.id,revision:d.revision,upserts:[],deleted:['process-a']})})()`,
  );
  await until(
    async () => (await pixelColors()).every(([r, g, b]) => r > 240 && g > 240 && b > 240),
    'missing original placeholder',
  );
  await screenshot('missing-original.png');
  await read(
    `(async()=>{const d=await window.canvas.invoke('loadBoard',{id:'${sourceBoard.id}'});await window.canvas.invoke('patchBoard',{id:d.board.id,revision:d.revision,upserts:[${JSON.stringify(sourceFrame)}],deleted:[]})})()`,
  );
  await until(
    async () => (await pixelColors()).every(([r, g, b]) => r > 180 && g < 80 && b < 100),
    'restored original reconnects',
  );
  assert.deepEqual(
    (await state()).objects,
    instances,
    'source changes never rewrite destination references',
  );
  const start = { x: surface.x + first.x + 80, y: surface.y + first.y + 80 };
  await mouse('mousePressed', start.x, start.y, 1);
  await mouse('mouseMoved', start.x + 25, start.y + 20, 1, 1);
  await mouse('mouseReleased', start.x + 25, start.y + 20);
  await until(
    async () => (await state()).objects.find((o) => o.id === first.id).x !== first.x,
    'move linked instance',
  );
  assert.equal(
    (await read(`window.canvas.invoke('loadBoard',{id:'${sourceBoard.id}'})`)).objects.find(
      (o) => o.id === sourceFrame.id,
    ).x,
    0,
  );
  await key('z', 'KeyZ', 2);
  await until(
    async () => (await state()).objects.find((o) => o.id === first.id).x === first.x,
    'undo instance move',
  );
  await worldClick(board.id, first.x + 80, first.y + 80);
  const corner = { x: surface.x + first.x + first.width, y: surface.y + first.y + first.height };
  await mouse('mousePressed', corner.x, corner.y, 1);
  await mouse('mouseMoved', corner.x + 40, corner.y + 30, 1, 1);
  await mouse('mouseReleased', corner.x + 40, corner.y + 30);
  await until(
    async () => (await state()).objects.find((o) => o.id === first.id).width > first.width,
    'resize linked instance',
  );
  await screenshot('resized-instance.png');
  await key('z', 'KeyZ', 2);
  await until(
    async () => (await state()).objects.find((o) => o.id === first.id).width === first.width,
    'undo instance resize',
  );
  await worldClick(board.id, first.x + 80, first.y + 80);
  await key('Delete');
  await until(async () => (await state()).objects.length === 2, 'delete one instance');
  await key('z', 'KeyZ', 2);
  await until(async () => (await state()).objects.length === 3, 'undo restores instance');
  await key('y', 'KeyY', 2);
  await until(async () => (await state()).objects.length === 2, 'redo removes instance');
  await key('z', 'KeyZ', 2);
  await until(async () => (await state()).objects.length === 3, 'undo again');
  const before = await read('performance.timeOrigin');
  await send('Page.reload');
  await until(
    () =>
      read(
        `performance.timeOrigin !== ${before} && !!document.querySelector('.canvas-surface canvas')`,
      ),
    'reload',
    ...(source ? ['PNG/JPG source and image pixels', 'PDF export'] : []),
  );
  await until(
    async () => (await pixelColors()).every(([r, g, b]) => r > 180 && g < 80 && b < 100),
    'references survive reload',
  );
  if (source) {
    await worldClick(board.id, first.x + 80, first.y + 80);
    for (const [index, format] of ['png', 'jpg', 'pdf'].entries()) {
      await click('[aria-label="Export selected"]');
      await click('[data-quality="2k"]');
      await click(`.export-formats button:nth-child(${index + 1})`);
      const file = join(root, `Process B board - selection.${format}`);
      await until(() => existsSync(file), `linked ${format} exported`);
      await until(
        () => read('!!document.querySelector(\'[aria-label="Dismiss export notification"]\')'),
        'export complete',
      );
      if (format !== 'pdf') {
        const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
        let red = 0,
          blue = 0;
        for (let i = 0; i < data.length; i += info.channels)
          if (data[i] > 180 && data[i + 1] < 80 && data[i + 2] < 100) red++;
        for (let i = 0; i < data.length; i += info.channels)
          if (data[i] < 100 && data[i + 1] < 130 && data[i + 2] > 180) blue++;
        assert.ok(red > info.width * info.height * 0.04, 'export includes source pixels');
        assert.ok(blue > info.width * info.height * 0.01, 'export includes referenced media');
      } else assert.ok(readFileSync(file).subarray(0, 4).toString() === '%PDF');
      await click('[aria-label="Dismiss export notification"]');
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'FRAME_LINKS_DESKTOP_OK',
    JSON.stringify({
      root,
      checks: [
        'copy/paste three links',
        'live content pixels',
        'read-only body and F2',
        'independent move/resize',
        'double-click cross-board navigation',
        'source edit and rename',
        'closed source external edits',
        'missing source and restoration',
        'undo/redo',
        'reload',
        ...(source ? ['PNG/JPG source and image pixels', 'PDF export'] : []),
      ],
      errors,
    }),
  );
} catch (error) {
  console.error(error);
  if (socket) {
    try {
      await screenshot('failure.png');
      console.error(await read('document.body.innerText'));
    } catch {}
  }
  console.error('Library:', root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
