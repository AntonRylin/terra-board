import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-lists-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Lists' });
store.patchBoard({
  id: board.id,
  revision: 0,
  deleted: [],
  camera: { x: 400, y: 300, zoom: 1 },
  upserts: [
    {
      id: 'frame',
      type: 'frame',
      x: 0,
      y: 0,
      width: 2000,
      height: 1200,
      z: 1,
      text: 'Frame overview',
    },
    {
      id: 'small',
      type: 'frame',
      x: 2400,
      y: 0,
      width: 240,
      height: 120,
      z: 2,
      text: 'Small frame',
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
const source = !!process.env.TERRA_SOURCE_CHECK;
const exportCheck = !!process.env.TERRA_EXPORT_CHECK;
const harness = join(root, 'export-main.cjs');
if (exportCheck)
  writeFileSync(
    harness,
    `
const {dialog}=require('electron');
dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(join(root, 'list-export.png'))}});
require(${JSON.stringify(resolve('electron/main.cjs'))});
`,
  );
const child = spawn(
  source || exportCheck
    ? require('electron')
    : resolve(process.env.TERRA_TEST_EXE || 'release/win-unpacked/Terra Board.exe'),
  [...(exportCheck ? [harness] : source ? [resolve('.')] : []), `--remote-debugging-port=${port}`],
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
async function click(selector) {
  const r = await until(() => rect(selector), selector);
  const x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, 1);
  await mouse('mouseReleased', x, y);
}
async function doubleClick(selector) {
  const r = await until(() => rect(selector), selector);
  const x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  await mouse('mouseMoved', x, y);
  for (const count of [1, 2]) {
    await mouse('mousePressed', x, y, 1, count);
    await mouse('mouseReleased', x, y, 0, count);
  }
}
const key = async (key, code = key, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
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
  }, 'target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p?.reject(Error(m.error.message)) : p?.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__frameDraws=[];const original=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...args){if(window.__frameDraws.length<100)window.__frameDraws.push({text,font:parseFloat(this.font.match(/([0-9.]+)px/)[1])});return original.call(this,text,...args);};`,
  });
  await until(
    () =>
      read(
        `!!document.querySelector('.canvas-surface canvas') && !document.getElementById('startup-screen')`,
      ),
    'initial canvas',
  );
  const originalObjects = (await state()).objects;
  const checks = [];
  for (const [zoom, expected] of [
    [1, 14],
    [0.25, 12],
    [0.1, 12],
    [0.025, 6.25],
    [2, 28],
    [8, 28],
  ]) {
    await read(
      `window.canvas.invoke('saveCamera',{id:${JSON.stringify(board.id)},camera:{x:400,y:300,zoom:${zoom}}})`,
    );
    await read('window.__oldFramePage=true');
    await send('Page.reload');
    const draw = await until(
      () =>
        read(
          `!window.__oldFramePage && window.__frameDraws?.filter(d=>d.text==='Frame overview').at(-1)`,
        ),
      'draw ' + zoom,
    );
    assert.ok(
      Math.abs(draw.font * zoom - expected) < 0.05,
      `title at ${zoom}: ${draw.font * zoom}, expected ${expected}`,
    );
    await until(
      () =>
        read(
          `!document.getElementById('startup-screen') && !document.querySelector('.canvas-loading')`,
        ),
      'ready after zoom',
    );
    if (zoom === 0.1) {
      const small = await read(`window.__frameDraws.filter(d=>d.text==='Small frame').at(-1)`);
      assert.equal(small.font, 30);
      await screenshot('frame-titles-10-percent.png');
    }
    if (zoom === 0.25) {
      await mouse('mouseMoved', 430, 283);
      await mouse('mousePressed', 430, 283, 1);
      await mouse('mouseReleased', 430, 283);
      await until(() => read(`!!document.querySelector('.text-editor')`), 'click enlarged title');
      const size = await read(
        `parseFloat(getComputedStyle(document.querySelector('.text-editor')).fontSize)`,
      );
      assert.equal(size, 12, 'editor matches visible title');
      const r = await rect('.text-editor');
      assert.ok(r.y < 300 && r.y + r.height < 300, 'editor stays above frame');
      await key('Escape');
    }
    checks.push({ zoom, screenFont: draw.font * zoom });
  }
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 700,
    y: 500,
    deltaX: 0,
    deltaY: 800,
  });
  const wheeled = await until(async () => {
    const c = (await state()).camera;
    return c.zoom < 7.9 && c;
  }, 'wheel zoom saves');
  const wheelDraw = await read(`window.__frameDraws.filter(d=>d.text==='Frame overview').at(-1)`);
  assert.ok(Math.abs(wheelDraw.font * wheeled.zoom - 28) < 0.05, 'title tracks live wheel zoom');
  assert.deepEqual(
    (await state()).objects,
    originalObjects,
    'zoom leaves saved frame sizes unchanged',
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'FRAME_TITLES_DESKTOP_OK', root, checks }));
} catch (error) {
  console.error(error);
  console.error(errors);
  console.error(await read('({old:window.__oldFramePage,draws:window.__frameDraws})'));
  process.exitCode = 1;
  if (socket)
    try {
      await screenshot('failure.png');
    } catch {}
} finally {
  socket?.close();
  child.kill();
}

