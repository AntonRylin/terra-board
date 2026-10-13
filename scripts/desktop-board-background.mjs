import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import sharp from 'sharp';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-board-background-'));
const files = [];
for (const [name, color] of [
  ['blue', '#345a80'],
  ['green', '#40765c'],
]) {
  const file = join(root, name + '.png');
  await sharp(
    Buffer.from(
      `<svg width="1600" height="900"><rect width="1600" height="900" fill="${color}"/><circle cx="1100" cy="280" r="210" fill="#ffffff" opacity=".15"/><path d="M0 700L600 300L1600 900H0Z" fill="#111827" opacity=".3"/></svg>`,
    ),
  )
    .png()
    .toFile(file);
  files.push(file);
}
const store = new Store(root);
const board = store.createBoard({ name: 'Wallpaper board' });
const other = store.createBoard({ name: 'Plain board' });
store.patchBoard({
  id: board.id,
  revision: 0,
  deleted: [],
  upserts: [
    {
      id: 'note',
      type: 'note',
      x: 300,
      y: 240,
      width: 250,
      height: 190,
      z: 1,
      text: 'Wallpaper stays still',
      color: '#f8efd4',
      fontSize: 22,
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
  resolve('release/win-unpacked/Terra Board.exe'),
  [`--remote-debugging-port=${port}`],
  { env, windowsHide: true, stdio: 'ignore' },
);
let socket,
  sequence = 0,
  chooser;
const pending = new Map(),
  errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(60);
  }
  throw Error('Timed out: ' + label);
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(method + ' timed out'));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function read(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails)
    throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const state = () => read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
const ready = () =>
  until(
    () =>
      read(
        `!!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading') && !document.querySelector('#startup-screen')`,
      ),
    'canvas ready',
  );
const wallpaper = () =>
  read(
    `(()=>{const e=document.querySelector('.board-wallpaper');if(!e)return null;const r=e.getBoundingClientRect();return {src:e.src,loaded:e.complete&&e.naturalWidth>0,fit:getComputedStyle(e).objectFit,pointer:getComputedStyle(e).pointerEvents,x:r.x,y:r.y,width:r.width,height:r.height}})()`,
  );
const screenshot = async (name) =>
  writeFileSync(
    join(root, name),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
async function menuAction(label) {
  await read(
    `document.querySelector('.board-identity').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:180,clientY:70}))`,
  );
  await until(
    () =>
      read(
        `!![...document.querySelectorAll('.context-menu button')].find(e=>e.textContent===${JSON.stringify(label)})`,
      ),
    label,
  );
  await read(
    `[...document.querySelectorAll('.context-menu button')].find(e=>e.textContent===${JSON.stringify(label)}).click()`,
  );
}
async function upload(file, label) {
  chooser = null;
  await menuAction(label);
  await until(() => chooser, 'file picker');
  await send('DOM.setFileInputFiles', { files: [file], backendNodeId: chooser.backendNodeId });
  await until(async () => (await wallpaper())?.loaded, 'wallpaper loaded');
}
async function openBoard(id) {
  await read(`document.querySelector('[data-item="${id}"]').click()`);
  await ready();
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
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown')
      errors.push(
        m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text,
      );
    else if (m.method === 'Page.fileChooserOpened') chooser = m.params;
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await send('Page.setInterceptFileChooserDialog', { enabled: true });
  await ready();
  await until(() => read(`document.documentElement.dataset.theme==='light'`), 'light theme');
  assert.equal(await wallpaper(), null);
  await upload(files[0], 'Set background image…');
  const first = await wallpaper();
  assert.equal(first.fit, 'cover');
  assert.equal(first.pointer, 'none');
  assert.equal(
    await read(`getComputedStyle(document.querySelector('.canvas-surface')).backgroundImage`),
    'none',
  );
  assert.equal((await state()).objects.length, 1);
  const before = (await state()).camera;
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 800,
    y: 500,
    deltaX: 0,
    deltaY: -160,
  });
  await until(async () => (await state()).camera.zoom !== before.zoom, 'zoom');
  assert.deepEqual(await wallpaper(), first, 'wallpaper remains fixed while zooming');
  const afterZoom = (await state()).camera;
  for (const [type, x, y] of [
    ['mousePressed', 800, 500],
    ['mouseMoved', 900, 560],
    ['mouseReleased', 900, 560],
  ])
    await send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'middle',
      buttons: type === 'mouseReleased' ? 0 : 4,
      clickCount: 1,
    });
  await until(async () => (await state()).camera.x !== afterZoom.x, 'pan');
  assert.deepEqual(await wallpaper(), first, 'wallpaper remains fixed while panning');
  const imageFilter = () =>
    read(`getComputedStyle(document.querySelector('.whiteboard .board-wallpaper')).filter`);
  const setSlider = async (id, value) => {
    await read(
      `(()=>{const input=document.getElementById('background-${id}');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${value});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await until(() => read(`document.getElementById('background-${id}').value === '${value}'`), id);
  };
  const dialogButton = (label) =>
    read(
      `[...document.querySelectorAll('[role="dialog"] button')].find(e=>e.textContent===${JSON.stringify(label)}).click()`,
    );
  await menuAction('Adjust background…');
  await setSlider('blur', 25);
  await until(async () => (await imageFilter()).includes('blur(25px)'), 'live blur');
  assert.equal((await state()).board.backgroundAppearance.blur, 0, 'preview does not save');
  await dialogButton('Cancel');
  await until(async () => (await imageFilter()).includes('blur(0px)'), 'cancel restores wallpaper');
  await menuAction('Adjust background…');
  await setSlider('sharpness', 80);
  await until(async () => (await imageFilter()).includes('url('), 'sharpening enabled');
  assert.match(
    await read(
      `document.querySelector('.whiteboard feConvolveMatrix').getAttribute('kernelMatrix')`,
    ),
    /4.2/,
  );
  await setSlider('brightness', 125);
  await setSlider('saturation', 145);
  await setSlider('blur', 12);
  for (const filter of ['sepia', 'mono', 'warm', 'cool', 'sepia']) {
    await read(
      `(()=>{const input=document.querySelector('[aria-label="Background filter"]');input.value='${filter}';input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await until(
      () =>
        read(`document.querySelector('[aria-label="Background filter"]').value === '${filter}'`),
      filter,
    );
    assert.match(
      await imageFilter(),
      filter === 'mono' ? /grayscale/ : filter === 'cool' ? /hue-rotate/ : /sepia/,
    );
  }
  await screenshot('background-adjustments.png');
  await dialogButton('Save');
  await until(
    async () => (await state()).board.backgroundAppearance.blur === 12,
    'saved adjustments',
  );
  const savedAppearance = {
    blur: 12,
    sharpness: 80,
    brightness: 125,
    saturation: 145,
    filter: 'sepia',
  };
  assert.deepEqual((await state()).board.backgroundAppearance, savedAppearance);
  await menuAction('Adjust background…');
  await dialogButton('Reset adjustments');
  await until(
    async () =>
      (await imageFilter()).includes('blur(0px)') && !(await imageFilter()).includes('url('),
    'reset',
  );
  await dialogButton('Cancel');
  await until(async () => (await imageFilter()).includes('blur(12px)'), 'cancel reset');
  await screenshot('wallpaper-light.png');
  await openBoard(other.id);
  await until(async () => !(await wallpaper()), 'plain board');
  await openBoard(board.id);
  await until(async () => (await wallpaper())?.loaded, 'return to wallpaper');
  const oldId = (await state()).board.backgroundAssetId;
  await upload(files[1], 'Change background image…');
  await until(async () => (await state()).board.backgroundAssetId !== oldId, 'replacement');
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await until(() => read(`document.documentElement.dataset.theme==='dark'`), 'dark theme');
  await screenshot('wallpaper-dark.png');
  const timeOrigin = await read('performance.timeOrigin');
  await send('Page.reload');
  await until(async () => (await read('performance.timeOrigin')) !== timeOrigin, 'reload');
  await ready();
  await until(async () => (await wallpaper())?.loaded, 'persisted wallpaper');
  assert.deepEqual((await state()).board.backgroundAppearance, savedAppearance);
  assert.match(await imageFilter(), /blur\(12px\)/);
  await menuAction('Remove background image');
  await until(async () => !(await wallpaper()), 'removal');
  assert.equal((await state()).board.backgroundAssetId, null);
  assert.match(
    await read(`getComputedStyle(document.querySelector('.canvas-surface')).backgroundImage`),
    /radial-gradient/,
  );
  assert.equal((await state()).objects.length, 1);
  assert.deepEqual(errors, []);
  console.log(
    'BOARD_BACKGROUND_DESKTOP_OK ' +
      JSON.stringify({
        root,
        checks: [
          'upload',
          'replace',
          'remove',
          'pan',
          'zoom',
          'board isolation',
          'reload',
          'light/dark',
          'objects preserved',
          'live blur, sharpness, brightness, saturation',
          'all filter presets',
          'save, cancel, reset and adjustment persistence',
        ],
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
  console.error(root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
