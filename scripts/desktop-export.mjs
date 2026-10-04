// Real export UI and file checks against an isolated desktop library.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import sharp from 'sharp';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/export-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Export fixture' });
const image = await store.importAsset({
  name: 'reference.png',
  bytes: await sharp(
    Buffer.from(
      '<svg width="4000" height="2000"><rect width="4000" height="2000" fill="#f5bd25"/><rect width="2000" height="2000" fill="#a046d0"/></svg>',
    ),
  )
    .png()
    .toBuffer(),
});
store.patchBoard({
  id: board.id,
  revision: 0,
  operationId: 'export-fixture',
  upserts: [
    {
      id: 'frame',
      type: 'frame',
      x: 100,
      y: 100,
      width: 1000,
      height: 500,
      z: -1,
      text: 'Export frame',
    },
    { id: 'red', type: 'rect', x: 200, y: 180, width: 150, height: 100, z: 1, color: '#e02030' },
    { id: 'green', type: 'rect', x: 260, y: 200, width: 150, height: 100, z: 2, color: '#20b060' },
    {
      id: 'offscreen',
      type: 'rect',
      x: 3000,
      y: 180,
      width: 150,
      height: 100,
      z: 3,
      color: '#3050e0',
    },
    {
      id: 'image',
      type: 'image',
      assetId: image.id,
      x: 500,
      y: 220,
      width: 180,
      height: 100,
      z: 4,
      rotation: 25,
      imageTitle: 'Reference image',
      crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
    },
    {
      id: 'note',
      type: 'note',
      x: 790,
      y: 190,
      width: 200,
      height: 140,
      z: 5,
      color: '#f8efd4',
      text: 'Export notes\nKeep the details.',
      fontSize: 22,
    },
  ],
  deleted: [],
  camera: { x: 0, y: 0, zoom: 1 },
});
store.setLastBoard({ id: board.id });
store.close();
const harness = join(root, 'export-main.cjs');
writeFileSync(
  harness,
  `
const {dialog,shell}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const root=process.env.CANVAS_DATA_DIR;
dialog.showSaveDialog=async (_win, options)=>{
  if(fs.existsSync(path.join(root,'cancel-next'))) {fs.unlinkSync(path.join(root,'cancel-next'));return {canceled:true};}
  await new Promise(resolve=>setTimeout(resolve,250));
  return {canceled:false,filePath:path.join(root,options.defaultPath)};
};
shell.openPath=async file=>{fs.appendFileSync(path.join(root,'open-actions.jsonl'),JSON.stringify({action:'file',file})+'\\n');return '';};
shell.showItemInFolder=file=>{fs.appendFileSync(path.join(root,'open-actions.jsonl'),JSON.stringify({action:'folder',file})+'\\n');};
require(${JSON.stringify(resolve('electron/main.cjs'))});
`,
);
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const env = { ...process.env, CANVAS_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
// This harness wraps the main process to supply deterministic native dialog responses.
const executable = require('electron');
const child = spawn(executable, [harness, `--remote-debugging-port=${port}`], {
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
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
    : { Enter: 13, Backspace: 8, Escape: 27, Tab: 9, Delete: 46 }[code] || 0;
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
  const ready = async () => {
    await until(
      () => read(`!!document.querySelector('canvas')&&!document.querySelector('.canvas-loading')`),
      'canvas ready',
    );
  };
  await ready();
  if (process.env.CANVAS_TEST_THEME) {
    await read(
      `localStorage.setItem('terra-board.theme',${JSON.stringify(process.env.CANVAS_TEST_THEME)})`,
    );
    await send('Page.reload');
    await sleep(400);
    await ready();
    await until(
      () =>
        read(
          `document.documentElement.dataset.theme===${JSON.stringify(process.env.CANVAS_TEST_THEME)}`,
        ),
      'export theme',
    );
  }
  const hostRect = await rect('.canvas-surface');
  const point = { x: hostRect.x + 220, y: hostRect.y + 220 };
  await click(point.x, point.y);
  await read(
    `window.exportProgressValues=[];new MutationObserver(()=>{const p=document.querySelector('progress[aria-label="Export progress"]');if(p)window.exportProgressValues.push(p.value)}).observe(document.body,{subtree:true,childList:true,attributes:true});`,
  );
  const choose = async (text) => {
    const location = await read(
      `(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!b) return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    assert.ok(location, text);
    await click(location.x, location.y);
  };
  for (const scope of ['selection', 'visible area']) {
    for (const format of ['PNG', 'JPG', 'PDF']) {
      await click(point.x, point.y, 'right');
      await choose(scope === 'selection' ? 'Export selected…' : 'Export visible area…');
      assert.ok(await read(`!!document.querySelector('.export-formats')`));
      if (scope === 'selection' && format === 'PNG')
        assert.equal(
          await read(
            `document.querySelector('[data-quality="full"]').getAttribute('aria-pressed')`,
          ),
          'true',
          'Full quality is the default',
        );
      await clickSelector('[data-quality="2k"]');
      if (scope === 'selection' && format === 'PNG') {
        await sleep(220);
        writeFileSync(
          join(root, 'export-dialog.png'),
          Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
        );
      }
      const formatButton = await read(
        `(()=>{const b=[...document.querySelectorAll('.export-formats button')].find(e=>e.querySelector('strong').textContent===${JSON.stringify(format)});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await click(formatButton.x, formatButton.y);
      if (scope === 'selection' && format === 'PNG') {
        await until(() => read(`!!document.querySelector('progress')`), 'export progress');
        writeFileSync(
          join(root, 'export-progress.png'),
          Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
        );
      }
      await until(
        () =>
          read(
            `!!document.querySelector('.export-actions') || !!document.querySelector('.error-banner')`,
          ),
        'export result',
      );
      assert.equal(await read(`document.querySelector('.error-banner')?.textContent || ''`), '');
      const file = join(root, `Export fixture - ${scope}.${format.toLowerCase()}`);
      assert.ok(existsSync(file), file);
      const bytes = readFileSync(file);
      if (format === 'PDF') {
        assert.ok(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
        const text = bytes.toString('latin1');
        const length = Number(text.match(/\/Filter \/FlateDecode \/Length (\d+)/)[1]);
        const start = bytes.indexOf(Buffer.from('stream\n')) + 7;
        const rgb = inflateSync(bytes.subarray(start, start + length));
        const png = await sharp(join(root, `Export fixture - ${scope}.png`))
          .removeAlpha()
          .raw()
          .toBuffer();
        assert.equal(rgb.length, png.length);
        // Separate GPU renders can differ by one rounding level at antialiased edges.
        assert.ok(
          rgb.every((value, i) => Math.abs(value - png[i]) <= 1),
          'PDF preserves PNG detail without compression artifacts',
        );
      } else {
        const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
        assert.equal(info.width, 2048);
        assert.equal(
          info.height,
          Math.floor(
            2048 *
              (scope === 'selection'
                ? 104 / 154
                : Math.floor(hostRect.height) / Math.floor(hostRect.width)),
          ),
        );
        let red = 0,
          green = 0,
          gold = 0,
          purple = 0;
        for (let i = 0; i < data.length; i += info.channels) {
          if (data[i] > 180 && data[i + 1] < 70) red++;
          if (data[i] < 70 && data[i + 1] > 130 && data[i + 2] < 150) green++;
          if (data[i] > 220 && data[i + 1] > 150 && data[i + 1] < 210 && data[i + 2] < 70) gold++;
          if (data[i] > 140 && data[i] < 190 && data[i + 1] < 100 && data[i + 2] > 180) purple++;
        }
        assert.ok(red > 4000, `${scope} ${format}: red item rendered (${red})`);
        assert.ok(
          scope === 'selection' ? green === 0 : green > 4000,
          `${scope} ${format}: correct overlap filtering (${green})`,
        );
        if (scope === 'visible area')
          assert.ok(gold > 4000 && purple > 4000, 'cropped and rotated original image rendered');
      }
      console.log('EXPORTED', file, bytes.length);
    }
  }
  await choose('Open file');
  await choose('Open folder');
  await until(
    () =>
      existsSync(join(root, 'open-actions.jsonl')) &&
      readFileSync(join(root, 'open-actions.jsonl'), 'utf8').includes('folder'),
    'open actions',
  );
  assert.ok((await read('exportProgressValues')).some((x) => x > 0));
  writeFileSync(
    join(root, 'export-toast.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  // Native cancellation must not leave a success toast or a busy export.
  writeFileSync(join(root, 'cancel-next'), '');
  await click(point.x, point.y, 'right');
  await choose('Export selected…');
  await clickSelector('[data-quality="4k"]');
  await clickSelector('.export-formats button');
  await until(() => !existsSync(join(root, 'cancel-next')), 'save dialog canceled');
  await sleep(120);
  assert.equal(await read(`!!document.querySelector('.export-toast')`), false);
  // Select all without fitting the board: the blue offscreen object must export.
  await read(`document.querySelector('.canvas-surface').focus()`);
  await key('a', 'KeyA', 2);
  await click(point.x, point.y, 'right');
  await choose('Export selected…');
  await clickSelector('.export-formats button');
  await until(
    () => read(`!!document.querySelector('.export-actions')`),
    'offscreen selection export',
  );
  const allFile = join(root, 'Export fixture - selection.png');
  const allMeta = await sharp(allFile).metadata();
  assert.ok(allMeta.width > 2900, 'offscreen objects are included');
  const allPixels = await sharp(allFile).raw().toBuffer({ resolveWithObject: true });
  let blue = 0;
  for (let i = 0; i < allPixels.data.length; i += allPixels.info.channels)
    if (allPixels.data[i] < 80 && allPixels.data[i + 2] > 180) blue++;
  assert.ok(blue > 10000, 'offscreen blue object rendered');
  assert.equal(allMeta.width, 4096, '4K preset uses the requested long edge');
  await clickSelector('.export-toast .icon-button');
  // The edge-to-edge launcher covers x=50; clear selection without clicking it.
  await key('Escape', 'Escape');
  const imagePoint = { x: hostRect.x + 590, y: hostRect.y + 270 };
  await click(imagePoint.x, imagePoint.y);
  await click(imagePoint.x, imagePoint.y, 'right');
  await sleep(180);
  await choose('Export selected…');
  await clickSelector('[data-quality="full"]');
  await clickSelector('.export-formats button');
  await until(
    () =>
      read(
        `!!document.querySelector('.export-actions') || !!document.querySelector('.error-banner')`,
      ),
    'full quality image export',
  );
  assert.equal(await read(`document.querySelector('.error-banner')?.textContent || ''`), '');
  const fullMeta = await sharp(allFile).metadata();
  assert.ok(
    fullMeta.width > 4000 && fullMeta.height > 2000,
    'Full quality retains original image density despite small on-board size',
  );
  console.log('FULL_QUALITY', fullMeta.width, fullMeta.height);
  await clickSelector('.export-toast .icon-button');
  // Selecting only a normal frame must export the objects inside it as well.
  await click(hostRect.x + 102, hostRect.y + 120);
  for (const format of ['PNG', 'JPG', 'PDF']) {
    await clickSelector('.selection-tools button[aria-label="Export selected"]');
    await until(() => read(`!!document.querySelector('.export-formats')`), 'frame export dialog');
    assert.equal(
      await read(`document.querySelector('.modal h2')?.textContent`),
      'Export selected items',
    );
    await clickSelector('[data-quality="2k"]');
    await choose(
      format === 'PNG'
        ? 'PNGCrisp images and text'
        : format === 'JPG'
          ? 'JPGSmaller file, easy to share'
          : 'PDFOne page, ready to print',
    );
    await until(() => read(`!!document.querySelector('.export-actions')`), 'frame export');
    assert.equal(await read(`document.querySelector('.error-banner')?.textContent || ''`), '');
    const file = join(root, `Export fixture - selection.${format.toLowerCase()}`);
    const bytes = readFileSync(file);
    let data, channels;
    if (format === 'PDF') {
      const length = Number(
        bytes.toString('latin1').match(/\/Filter \/FlateDecode \/Length (\d+)/)[1],
      );
      const start = bytes.indexOf(Buffer.from('stream\n')) + 7;
      data = inflateSync(bytes.subarray(start, start + length));
      channels = 3;
    } else {
      const raw = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
      data = raw.data;
      channels = raw.info.channels;
      assert.equal(raw.info.width, 2048);
    }
    let red = 0,
      green = 0,
      purple = 0,
      blue = 0;
    for (let i = 0; i < data.length; i += channels) {
      if (data[i] > 180 && data[i + 1] < 70) red++;
      if (data[i] < 70 && data[i + 1] > 130 && data[i + 2] < 150) green++;
      if (data[i] > 140 && data[i] < 190 && data[i + 1] < 100 && data[i + 2] > 180) purple++;
      if (data[i] < 90 && data[i + 1] < 110 && data[i + 2] > 180) blue++;
    }
    assert.ok(red > 4000 && green > 4000 && purple > 4000, `${format}: frame contents rendered`);
    assert.equal(blue, 0, `${format}: outside object excluded`);
    console.log('FRAME_EXPORTED', file);
    await clickSelector('.export-toast .icon-button');
  }
  assert.deepEqual(errors, []);
  console.log('EXPORT_DESKTOP_OK', root);
} finally {
  socket?.close();
  child.kill();
}
