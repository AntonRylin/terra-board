// Run after npm run package: node scripts/desktop-pdf-composer.mjs
// CANVAS_EXECUTABLE can select another packaged build. The real Electron child,
// library, source files, native downloads and screenshots are disposable and local.
// Optional legacy Office check: CANVAS_OFFICE_RUNTIME is an already verified
// libreoffice-<version> folder; CANVAS_OFFICE_FIXTURES is a JSON manifest containing
// {files:[{file:"relative/source.doc",textMarkers:["Expected text"],multipage:false}]}.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { inspectPdfPages, pdfComposerFixtures } from '../tests/pdf-workspace-fixtures.mjs';

const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const officeManifest = process.env.CANVAS_OFFICE_FIXTURES;
const officeFixtures = officeManifest
  ? JSON.parse(readFileSync(officeManifest, 'utf8')).files.map((entry) => {
      const file = resolve(dirname(resolve(officeManifest)), entry.file);
      assert.ok(
        /\.(doc|xls|ppt)$/i.test(file),
        'legacy fixtures use actual DOC/XLS/PPT extensions',
      );
      assert.ok(
        Array.isArray(entry.textMarkers) && entry.textMarkers.length,
        'legacy fixture provides independent expected text',
      );
      return {
        name: entry.name || basename(file),
        bytes: readFileSync(file),
        textMarkers: entry.textMarkers,
        multipage: !!entry.multipage,
      };
    })
  : [];
const fixtures = await pdfComposerFixtures(officeFixtures);
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-pdf-composer-'));
if (officeFixtures.length) {
  assert.ok(
    process.env.CANVAS_OFFICE_RUNTIME,
    'provide the verified Office runtime to avoid a test download',
  );
  const runtime = resolve(process.env.CANVAS_OFFICE_RUNTIME);
  assert.match(
    basename(runtime),
    /^libreoffice-[\d.]+$/,
    'expected versioned app-local Office engine',
  );
  assert.ok(
    existsSync(join(runtime, 'program', 'soffice.exe')),
    'verified Office runtime is present',
  );
  mkdirSync(join(root, 'tools'), { recursive: true });
  symlinkSync(runtime, join(root, 'tools', basename(runtime)), 'junction');
}
mkdirSync(join(root, 'fixtures'));
for (const fixture of Object.values(fixtures)) {
  fixture.path = join(root, 'fixtures', fixture.name);
  writeFileSync(fixture.path, fixture.bytes);
}
const store = new Store(root);
const board = store.createBoard({ name: 'PDF composer check' });
const sourceCards = [];
for (const [index, key] of ['source', 'merge', 'rotated', 'png'].entries()) {
  const fixture = fixtures[key];
  const asset = await store.importAsset({ bytes: fixture.bytes, name: fixture.name });
  sourceCards.push({
    id: `composer-source-${key}`,
    type: key === 'png' ? 'image' : 'document',
    x: 200 + index * 260,
    y: 140,
    width: 160,
    height: key === 'png' ? 120 : 200,
    z: index + 1,
    text: fixture.name,
    assetId: asset.id,
    ...(key === 'png' ? {} : { documentMime: asset.mime, documentBytes: asset.bytes }),
  });
}
store.patchBoard({
  id: board.id,
  revision: 0,
  upserts: sourceCards,
  deleted: [],
  camera: { x: 0, y: 0, zoom: 1 },
});
store.setLastBoard({ id: board.id });
store.close();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const originalAsset = (id) => readFileSync(join(root, 'assets', `${id}.original`));
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const rendererPort = await freePort(),
  inspectorPort = await freePort();
const executable = process.env.CANVAS_EXECUTABLE || resolve('release/win-unpacked/Terra Board.exe');
assert.ok(existsSync(executable), `Package Terra Board first: ${executable}`);
const env = { ...process.env, CANVAS_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const child = spawn(
  executable,
  [`--remote-debugging-port=${rendererPort}`, `--inspect=127.0.0.1:${inspectorPort}`],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let diagnostics = '',
  launchError,
  renderer,
  main,
  mainReadiness,
  completed = false,
  activeBoard = board;
const errors = [],
  steps = [];
child.on('error', (error) => {
  launchError = error;
});
child.stderr.on('data', (data) => {
  diagnostics += data;
});
child.stdout.on('data', (data) => {
  diagnostics += data;
});
console.log('PDF_COMPOSER_STARTED', JSON.stringify({ root, executable, pid: child.pid }));

async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw Error(`Terra exited (${child.exitCode}): ${diagnostics}`);
    const value = await fn();
    if (value) return value;
    await sleep(80);
  }
  throw Error(`Timed out: ${label}`);
}
async function targetAt(port, filter) {
  return until(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(filter);
    } catch {
      return null;
    }
  }, `debug target on ${port}`);
}
async function connect(url, reportErrors = false) {
  const socket = new WebSocket(url),
    pending = new Map(),
    events = [];
  let sequence = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (request) {
        clearTimeout(request.timer);
        message.error
          ? request.reject(Error(`${request.method}: ${message.error.message}`))
          : request.resolve(message.result);
      }
    } else {
      if (['Page.fileChooserOpened', 'Fetch.requestPaused'].includes(message.method))
        events.push(message);
      if (message.method === 'Runtime.exceptionThrown' && reportErrors)
        errors.push(
          message.params.exceptionDetails.exception?.description ||
            message.params.exceptionDetails.text,
        );
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(Error(`CDP timed out: ${method} ${JSON.stringify(params).slice(0, 1500)}`));
        },
        method.startsWith('Input.') ? 15000 : 30000,
      );
      pending.set(id, { resolve, reject, timer, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    events,
    async read(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    close() {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(Error('Debugger connection closed'));
      }
      pending.clear();
      socket.close();
    },
  };
}
const read = (expression) => renderer.read(expression);
const state = (board = activeBoard) =>
  read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
async function saved(test, label, board = activeBoard) {
  return until(async () => {
    const current = await state(board);
    return test(current) ? current : null;
  }, label);
}
const rect = (selector) =>
  read(`(() => {
  const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return null;
  const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};
})()`);
async function mouse(type, point, button = 'left', count = 1, buttons) {
  await renderer.send('Input.dispatchMouseEvent', {
    type,
    ...point,
    button,
    clickCount: count,
    buttons: buttons ?? (type === 'mouseReleased' ? 0 : button === 'right' ? 2 : 1),
  });
}
async function clickPoint(point, button = 'left', count = 1) {
  await mouse('mouseMoved', point, button, count, 0);
  await mouse('mousePressed', point, button, count);
  await mouse('mouseReleased', point, button, count);
}
async function click(selector) {
  let previous;
  const r = await until(async () => {
    const current = await read(`(() => {
      const e=document.querySelector(${JSON.stringify(selector)});if(!e || e.disabled)return null;
      const r=e.getBoundingClientRect(),s=getComputedStyle(e);
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      if(r.width<=0 || r.height<=0 || s.visibility!=='visible' || s.display==='none'
        || !hit || !(e===hit || e.contains(hit)))return null;
      return {x:r.x,y:r.y,width:r.width,height:r.height};
    })()`);
    const stable =
      current &&
      previous &&
      ['x', 'y', 'width', 'height'].every((key) => Math.abs(current[key] - previous[key]) < 0.5);
    previous = current;
    return stable ? current : null;
  }, `${selector} is visible, stable and accepts pointer input`);
  await clickPoint({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
}
async function key(key, code, modifiers = 0) {
  const windowsVirtualKeyCode = code.startsWith('Key')
    ? code.charCodeAt(3)
    : { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowRight: 39 }[
        code
      ] || 0;
  for (const type of ['keyDown', 'keyUp'])
    await renderer.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
      ...(type === 'keyDown' && code === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
    });
}
async function replaceText(selector, text) {
  await click(selector);
  await key('a', 'KeyA', 2);
  await renderer.send('Input.insertText', { text });
  await key('Enter', 'Enter');
}
async function shot(name) {
  const { data } = await renderer.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, `${name}.png`), Buffer.from(data, 'base64'));
}
function checkpoint(name) {
  steps.push(name);
  console.log('PDF_COMPOSER_CHECK', name);
}
async function boardReady() {
  await until(
    () =>
      read(`document.querySelector('.board-title')?.textContent===${JSON.stringify(activeBoard.name)}
    && !!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading')`),
    'board canvas ready',
  );
}
async function openBoard(board) {
  if (board.id !== activeBoard.id) {
    if (await read(`document.querySelector('.app-shell').hasAttribute('data-panel-hidden')`))
      await click('[aria-label="Show board panel"]');
    await click(`[aria-label=${JSON.stringify(`Open board ${board.name}`)}]`);
    activeBoard = board;
  }
  await boardReady();
}
async function point(object, dx = 12, dy = 12) {
  const camera = (await state()).camera,
    host = await rect('.canvas-surface');
  return {
    x: host.x + (object.x + dx) * camera.zoom + camera.x,
    y: host.y + (object.y + dy) * camera.zoom + camera.y,
  };
}
async function select(object) {
  await key('Escape', 'Escape');
  await clickPoint(await point(object));
  await until(
    () => rect('.selection-tools [aria-label="Duplicate selection"]'),
    'object selected by pointer',
  );
}
async function nativeDrop(files, selector) {
  const r = await rect(selector);
  assert.ok(r, `drop target ${selector}`);
  const point = { x: r.x + r.width * 0.48, y: r.y + r.height * 0.52 };
  for (const type of ['dragEnter', 'dragOver', 'drop'])
    await renderer.send('Input.dispatchDragEvent', {
      type,
      ...point,
      data: { items: [], files: files.map((fixture) => fixture.path), dragOperationsMask: 1 },
    });
}
async function importOnBoard(fixture, type) {
  await nativeDrop([fixture], '.canvas-surface');
  const document = await saved(
    (doc) => doc.objects.some((o) => o.type === type && o.text === fixture.name),
    `native ${type} import`,
  );
  const object = document.objects.find((o) => o.type === type && o.text === fixture.name);
  assert.equal(object.assetId, hash(fixture.bytes));
  assert.deepEqual(originalAsset(object.assetId), fixture.bytes);
  return object;
}

const composerRoot = '.canvas-pdf-composer';
let composerId, originalObjects;
const composerSelector = () => `${composerRoot}[data-composer-id=${JSON.stringify(composerId)}]`;
const columnSelector = (id) =>
  `${composerSelector()} .pdf-composer-column[data-column-id=${JSON.stringify(id)}]`;
const pageSelector = (id) =>
  `${composerSelector()} .pdf-composer-page[data-page-id=${JSON.stringify(id)}]`;
const composer = async () => (await state()).objects.find((object) => object.id === composerId);
const snapshot = (value) => JSON.parse(JSON.stringify(value));
const graph = async () => (await composer())?.pdfComposer;
const ids = (column) => column.pages.map((page) => page.id);
const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

async function nativeDrag(from, to, beforeRelease) {
  await mouse('mouseMoved', from, 'left', 1, 0);
  await mouse('mousePressed', from);
  for (let step = 1; step <= 12; step++)
    await mouse('mouseMoved', {
      x: from.x + ((to.x - from.x) * step) / 12,
      y: from.y + ((to.y - from.y) * step) / 12,
    });
  if (beforeRelease) await beforeRelease();
  await mouse('mouseReleased', to);
}
async function watchMotion() {
  await read(`(() => {
    window.__composerMotionObserver?.disconnect();
    window.__composerMotionSamples=[];
    window.__composerMotionObserver=new MutationObserver(()=>{
      const root=document.querySelector(${JSON.stringify(composerSelector())});
      if(root?.dataset.layoutAnimating!=='true')return;
      const targets=[...root.querySelectorAll('[data-layout-motion]'),...document.querySelectorAll('.pdf-composer-motion-page')];
      window.__composerMotionSamples.push(targets.map(node=>({
        kind:node.dataset.layoutMotion || 'page',pageId:node.dataset.motionPageId || node.dataset.pageId,
        animations:node.getAnimations().map(animation=>({state:animation.playState,duration:animation.effect?.getTiming().duration,
          keyframes:animation.effect?.getKeyframes().map(frame=>({transform:frame.transform,opacity:frame.opacity}))}))
      })));
      if(window.__composerMotionSamples.length>60)window.__composerMotionSamples.shift();
    });
    window.__composerMotionObserver.observe(document.body,{subtree:true,attributes:true,
      attributeFilter:['data-layout-animating','data-layout-motion','data-motion-page-id']});
  })()`);
}
async function assertMotion(kind, reduced = false) {
  if (!reduced)
    await until(
      () =>
        read(`window.__composerMotionSamples.flat().some(target=>target.kind===${JSON.stringify(kind)} &&
    target.animations.some(animation=>animation.state==='running' && animation.duration>0 && animation.keyframes.length>1))`),
      `native ${kind} reorder has in-flight movement`,
    );
  await until(
    () =>
      read(
        `document.querySelector(${JSON.stringify(composerSelector())})?.dataset.layoutAnimating!=='true'`,
      ),
    'reorder movement settles',
  );
  if (reduced) {
    await sleep(320);
    assert.deepEqual(
      await read('window.__composerMotionSamples'),
      [],
      'reduced motion skips page movement animations',
    );
  }
  const samples = await read('window.__composerMotionSamples');
  await read('window.__composerMotionObserver.disconnect()');
  writeFileSync(
    join(root, `motion-${kind}${reduced ? '-reduced' : ''}.json`),
    JSON.stringify(samples, null, 2),
  );
}
async function loadingVisible(local) {
  await until(
    () =>
      read(`(() => {
    const visible=selector=>{const node=document.querySelector(selector);if(!node)return false;
      const r=node.getBoundingClientRect();return r.width>20 && r.height>0 && getComputedStyle(node).visibility==='visible';};
    return visible('.import-status [role="progressbar"]') &&
      !!document.querySelector('.import-status > span')?.textContent.trim() &&
      (${!local} || (visible('.pdf-composer-progress[role="progressbar"]') &&
        document.querySelector(${JSON.stringify(composerSelector())})?.getAttribute('aria-busy')==='true'));
  })()`),
    local ? 'global and composer conversion bars are visible' : 'composer creation bar is visible',
  );
}
async function heldCreation(action, assetId) {
  await read(`(() => {
    const original=window.fetch,gate=window.__composerFetchGate={original,armed:true,started:0,released:false,watchdogFired:false};
    window.fetch=async function(input,init){
      const url=typeof input==='string'?input:input?.url || String(input);
      if(gate.armed && url===${JSON.stringify(`canvas-media://asset/${assetId}/original`)}){
        gate.armed=false;gate.started=Date.now();
        await new Promise(resolve=>{
          const watchdog=setTimeout(()=>{gate.watchdogFired=true;gate.release();},10000);
          gate.release=()=>{if(gate.released)return;gate.released=true;clearTimeout(watchdog);resolve();};
        });
      }
      return original.call(this,input,init);
    };
  })()`);
  try {
    await action();
    await until(
      () => read('window.__composerFetchGate.started>0'),
      'creation holds its real source read',
    );
    await loadingVisible(false);
    await shot('composer-creation-progress');
    assert.equal(await read('window.__composerFetchGate.watchdogFired'), false);
  } finally {
    await read(
      '(() => {const gate=window.__composerFetchGate;gate.release?.();window.fetch=gate.original;})()',
    );
  }
}
async function holdConversion() {
  await main.read(`(() => {
    const {ipcMain}=process.mainModule.require('electron'),channel='canvas:print-document';
    const original=ipcMain._invokeHandlers.get(channel);
    if(typeof original!=='function')throw Error('Expected real native print handler');
    const gate=globalThis.__composerPrintGate={original,channel,armed:true,started:0,released:false,watchdogFired:false,restored:false};
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel,async(...args)=>{
      if(gate.armed){gate.armed=false;gate.started=Date.now();await new Promise(resolve=>{
        const watchdog=setTimeout(()=>{gate.watchdogFired=true;gate.release();},10000);
        gate.release=()=>{if(gate.released)return;gate.released=true;clearTimeout(watchdog);resolve();};
      });}
      return original(...args);
    });
  })()`);
}
async function releaseConversion() {
  if (main)
    await main.read(`(() => {
    const gate=globalThis.__composerPrintGate;if(!gate || gate.restored)return;
    gate.release?.();const {ipcMain}=process.mainModule.require('electron');
    ipcMain.removeHandler(gate.channel);ipcMain.handle(gate.channel,gate.original);gate.restored=true;
  })()`);
}
async function canvasHit(p, label) {
  await until(
    () =>
      read(
        `document.elementFromPoint(${p.x},${p.y})?.getAttribute('aria-label')==='Infinite whiteboard'`,
      ),
    label,
  );
}
async function assertOriginals() {
  const objects = (await state()).objects;
  for (const expected of originalObjects) {
    assert.deepEqual(
      objects.find((object) => object.id === expected.id),
      expected,
      'composer gestures preserve each original card and its geometry',
    );
    const fixture = Object.values(fixtures).find((item) => item.name === expected.text);
    assert.deepEqual(
      originalAsset(expected.assetId),
      fixture.bytes,
      'composer gestures preserve exact original asset bytes',
    );
  }
}
async function expectGraph(expected, label) {
  await until(async () => JSON.stringify(await graph()) === JSON.stringify(expected), label);
  return assertDomGraph(expected);
}
async function assertDomGraph(expected = undefined) {
  expected ||= await graph();
  const expectedOrder = expected.columns.map((column) => ({ id: column.id, pages: ids(column) }));
  const actual = await until(async () => {
    const order =
      await read(`Array.from(document.querySelectorAll(${JSON.stringify(`${composerSelector()} .pdf-composer-column`)}),
      column=>({id:column.dataset.columnId,pages:Array.from(column.querySelectorAll('.pdf-composer-page'),page=>page.dataset.pageId)}))`);
    return JSON.stringify(order) === JSON.stringify(expectedOrder) ? order : null;
  }, 'composer DOM order catches up with its persisted graph');
  assert.deepEqual(
    actual,
    expectedOrder,
    'DOM columns and pages match the persisted composer order',
  );
}
async function settleCamera() {
  let previous;
  return until(async () => {
    const document = await state(),
      current = document.camera;
    const object = document.objects.find((item) => item.id === composerId);
    const visible = await rect(composerSelector()),
      host = await rect('.canvas-surface');
    const agrees =
      object &&
      visible &&
      Math.abs(visible.x - (host.x + object.x * current.zoom + current.x)) < 1 &&
      Math.abs(visible.y - (host.y + object.y * current.zoom + current.y)) < 1 &&
      Math.abs(visible.width - object.width * current.zoom) < 1;
    const stable =
      agrees &&
      previous &&
      ['x', 'y', 'zoom'].every((key) => Math.abs(current[key] - previous[key]) < 0.001);
    previous = current;
    return stable ? current : null;
  }, 'board camera persists and settles');
}
async function fitBoard() {
  await click('[aria-label="Fit board"]');
  await settleCamera();
  await until(() => rect(composerSelector()), 'composer remains visible after board fit');
}
async function moveComposerBelowCards() {
  const object = await composer(),
    camera = await settleCamera();
  const header = await rect(`${composerSelector()} .pdf-composer-header`);
  assert.ok(header, 'composer exposes a frame movement header');
  const start = { x: header.x + 14, y: header.y + Math.min(18, header.height / 2) };
  const destination = {
    x: start.x + (180 - object.x) * camera.zoom,
    y: start.y + (420 - object.y) * camera.zoom,
  };
  await nativeDrag(start, destination);
  await saved((document) => {
    const moved = document.objects.find((item) => item.id === composerId);
    return Math.abs(moved.x - 180) < 3 && Math.abs(moved.y - 420) < 3;
  }, 'composer frame moves independently of source cards');
  await assertOriginals();
  await fitBoard();
}
async function bringIntoView(selector) {
  await read(
    `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`,
  );
  return until(async () => {
    const r = await rect(selector);
    return r?.width > 0 && r.height > 0 ? r : null;
  }, `${selector} has visible geometry`);
}
async function pageDrop(pageId, destinationColumnId, targetPageId, after = false) {
  const targetSelector = targetPageId
    ? pageSelector(targetPageId)
    : `${columnSelector(destinationColumnId)} .pdf-composer-pages`;
  await bringIntoView(targetSelector);
  const from = await bringIntoView(pageSelector(pageId));
  const target = await rect(targetSelector);
  const start = { x: from.x + from.width / 2, y: from.y + Math.min(18, from.height / 4) };
  const end = targetPageId
    ? {
        x: target.x + target.width / 2,
        y: target.y + (after ? target.height * 0.8 : Math.min(5, target.height / 5)),
      }
    : { x: target.x + target.width / 2, y: target.y + Math.min(50, target.height / 2) };
  await nativeDrag(start, end);
}
async function columnDrop(fromId, targetId, after = false) {
  await bringIntoView(columnSelector(targetId));
  const from = await bringIntoView(`${columnSelector(fromId)} .pdf-composer-column-handle`);
  const target = await rect(columnSelector(targetId));
  await nativeDrag(center(from), {
    x: target.x + target.width * (after ? 0.8 : 0.2),
    y: from.y + from.height / 2,
  });
}
async function undoRedo(before, after, label) {
  await read('document.activeElement?.blur()');
  await key('z', 'KeyZ', 2);
  await expectGraph(before, `${label} undo is one board transaction`);
  await key('z', 'KeyZ', 10);
  await expectGraph(after, `${label} redo restores exact identities and order`);
}
async function appendBoardCard(card, columnCount) {
  await fitBoard();
  const from = await point(card, card.width / 2, card.height / 2);
  await canvasHit(from, 'source board card accepts native drag');
  const frame = await rect(composerSelector());
  const to = { x: frame.x + frame.width * 0.55, y: frame.y + Math.min(160, frame.height / 2) };
  await nativeDrag(from, to, async () => {
    await until(
      () => rect('.pdf-composer-drop-target'),
      'PDF target feedback appears during native drag',
    );
    await shot(`composer-append-${columnCount}-drop-target`);
  });
  await saved(
    (document) =>
      document.objects.find((item) => item.id === composerId)?.pdfComposer.columns.length ===
      columnCount,
    'native board drag appends one source column',
  );
  const added = (await graph()).sources.at(-1);
  assert.equal(
    added.assetId,
    card.assetId,
    'native drag appends the exact source card under the pointer',
  );
  assert.equal(added.name, card.text);
  await assertOriginals();
  await assertDomGraph();
}
async function setAppearance(theme, reduced = false) {
  await renderer.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: theme },
      { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' },
    ],
  });
  await until(
    () =>
      read(`document.documentElement.dataset.theme===${JSON.stringify(theme)} &&
    !document.documentElement.matches(':active-view-transition') &&
    matchMedia('(prefers-reduced-motion: reduce)').matches===${reduced}`),
    `${theme} composer appearance settles`,
  );
}
async function checkBorderMotion() {
  const path = `${composerSelector()} .canvas-list-edit-outline path`;
  await click(`${composerSelector()} .pdf-composer-header`);
  const initial = await until(
    () => read(`document.querySelector(${JSON.stringify(path)})?.getAttribute('d')`),
    'active composer outline',
  );
  await until(
    async () =>
      (await read(`document.querySelector(${JSON.stringify(path)})?.getAttribute('d')`)) !==
      initial,
    'active composer border animates',
  );
  await setAppearance('light', true);
  let previousPath;
  const stationary = await until(async () => {
    const value = await read(`document.querySelector(${JSON.stringify(path)})?.getAttribute('d')`);
    const stable = value && value === previousPath;
    previousPath = value;
    return stable ? value : null;
  }, 'reduced-motion border settles');
  await sleep(240);
  assert.equal(
    await read(`document.querySelector(${JSON.stringify(path)})?.getAttribute('d')`),
    stationary,
    'reduced motion stops composer outline animation',
  );
  await shot('composer-reduced-motion');
  await setAppearance('light');
}
async function download(action, name) {
  const count = await main.read('globalThis.__pdfComposerDownloads.calls.length');
  await action();
  let previousSize;
  const call = await until(
    async () => {
      const entry = (await main.read('globalThis.__pdfComposerDownloads.calls'))[count];
      if (!entry || entry.canceled || !existsSync(entry.filePath)) return null;
      const size = statSync(entry.filePath).size,
        stable = size > 0 && size === previousSize;
      previousSize = size;
      return stable ? entry : null;
    },
    `native column download ${name}`,
    30000,
  );
  assert.equal(basename(call.defaultPath), name, 'native picker preserves the column filename');
  return { ...call, bytes: readFileSync(call.filePath) };
}
const exportedName = (name) =>
  name.replace(
    /\.(pdf|png|jpe?g|webp|gif|avif|tiff?|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|md|html?)$/i,
    '',
  ) + '.pdf';
function expectedPdfPages(composition, column) {
  return column.pages.map((page) => {
    const source = composition.sources.find((item) => item.id === page.sourceId);
    const fixture = Object.values(fixtures).find((item) => hash(item.bytes) === source.assetId);
    assert.ok(fixture, `known immutable source ${source.name}`);
    const original = fixture.pages?.[page.pageIndex];
    return {
      width: original?.width ?? fixture.width,
      height: original?.height ?? fixture.height,
      rotation: ((original?.rotation || 0) + page.rotation) % 360,
      marker: original?.marker ?? null,
    };
  });
}
async function inspectTextPdf(bytes, fixture, expectedPageCount) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({
    data: Uint8Array.from(bytes),
    isEvalSupported: false,
    disableFontFace: true,
  });
  try {
    const pdf = await loading.promise;
    assert.equal(
      pdf.numPages,
      expectedPageCount,
      'converted source page count matches the exported PDF',
    );
    if (fixture.multipage)
      assert.ok(pdf.numPages > 1, 'long native text conversion produces multiple pages');
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index),
        content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str || '').join(' '));
    }
    const text = pages.join('\n').replace(/\s+/g, ' ');
    let previous = -1;
    for (const marker of fixture.textMarkers) {
      const position = text.indexOf(marker);
      assert.ok(position > previous, `converted PDF preserves ordered text marker ${marker}`);
      previous = position;
    }
    if (fixture === fixtures.text)
      for (const word of ['café', '日本語', 'Україна'])
        assert.ok(text.includes(word), `text PDF preserves Unicode ${word}`);
    return { pages: pdf.numPages, text };
  } finally {
    await loading.destroy();
  }
}
async function exportColumn(composition, column, focus = false, textFixture) {
  const selector = `${columnSelector(column.id)} .pdf-composer-export`;
  await read(`(() => {
    window.__composerInputEvents=[];
    if(window.__composerInputTracking)return;window.__composerInputTracking=true;
    for(const type of ['keydown','keyup','click'])document.addEventListener(type,event=>{
      window.__composerInputEvents.push({type,key:event.key,target:event.target.tagName,
        label:event.target.getAttribute?.('aria-label'),active:document.activeElement?.getAttribute('aria-label'),disabled:event.target.disabled});
      if(window.__composerInputEvents.length>40)window.__composerInputEvents.shift();
    },true);
  })()`);
  await bringIntoView(columnSelector(column.id));
  await until(
    () => read(`!document.querySelector(${JSON.stringify(selector)}).disabled`),
    'column export is ready',
  );
  if (focus) {
    // DOM focus only chooses the keyboard starting point; the actual export is
    // activated through native Enter and still writes via the real main IPC.
    await read(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    assert.equal(
      await read(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`),
      true,
    );
  } else {
    const r = await rect(columnSelector(column.id));
    await mouse('mouseMoved', { x: r.x + r.width / 2, y: r.y + 40 }, 'left', 1, 0);
  }
  await until(
    () =>
      read(
        `Number(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity)>0.75`,
      ),
    'column export appears on hover or keyboard focus',
  );
  const output = await download(
    () => (focus ? key('Enter', 'Enter') : click(selector)),
    exportedName(column.name),
  );
  if (textFixture) {
    const extracted = await inspectTextPdf(output.bytes, textFixture, column.pages.length);
    writeFileSync(
      join(root, `${textFixture.name}.export-text.json`),
      JSON.stringify(extracted, null, 2),
    );
  } else {
    assert.deepEqual(
      await inspectPdfPages(output.bytes),
      expectedPdfPages(composition, column),
      'downloaded column PDF preserves source vector text, order, dimensions and rotation',
    );
  }
  await assertOriginals();
}
async function dismissError() {
  const dismiss = await rect('.error-banner button');
  if (dismiss) await click('.error-banner button');
}
async function rejectedDrop(files, label) {
  const before = snapshot(await graph()),
    count = (await state()).objects.length;
  const previousError = await read(
    `document.querySelector('.error-banner[role="alert"],.pdf-composer-status[role="alert"]')?.textContent || ''`,
  );
  await nativeDrop(files, composerSelector());
  await until(
    () =>
      read(`(() => {
        const value=document.querySelector('.error-banner[role="alert"],.pdf-composer-status[role="alert"]')?.textContent;
        return value && value!==${JSON.stringify(previousError)} && !document.querySelector(${JSON.stringify(`${composerSelector()} .pdf-composer-header button`)}).disabled;
      })()`),
    `${label} reports a bounded error`,
  );
  assert.deepEqual(await graph(), before, `${label} cannot partially change the composer`);
  assert.equal((await state()).objects.length, count, `${label} does not create loose board cards`);
  await assertOriginals();
  await dismissError();
}
async function convertAttachments(attachments, label) {
  const before = snapshot(await graph());
  const held = attachments.includes(fixtures.docx);
  if (held) await holdConversion();
  try {
    await nativeDrop(attachments, composerSelector());
    if (held) {
      await until(
        () => main.read('globalThis.__composerPrintGate.started>0'),
        'native document conversion is held',
      );
      await loadingVisible(true);
      await shot('composer-conversion-progress');
      await setAppearance('light', true);
      await until(
        () =>
          read(`['.import-progress-track','.pdf-composer-progress'].every(selector=>
        !document.querySelector(selector)?.getAnimations({subtree:true}).some(animation=>animation.playState==='running'))`),
        'reduced motion keeps loading bars static',
      );
      await shot('composer-conversion-progress-reduced');
      assert.equal(await main.read('globalThis.__composerPrintGate.watchdogFired'), false);
      await setAppearance('light');
    }
  } finally {
    if (held) await releaseConversion();
  }
  await until(
    async () => {
      const current = await graph();
      return current.columns.length === before.columns.length + attachments.length;
    },
    `native ${label} drop creates one converted PDF column per file`,
    120000,
  );
  const converted = snapshot(await graph());
  const columns = converted.columns.slice(-attachments.length);
  assert.deepEqual(
    columns.map((column) => column.name),
    attachments.map((fixture) => fixture.name),
  );
  for (const [index, fixture] of attachments.entries()) {
    const column = columns[index];
    const source = converted.sources.find((entry) => entry.id === column.pages[0].sourceId);
    assert.equal(source.kind, 'pdf', 'convertible inputs become persistent PDF sources');
    assert.notEqual(source.assetId, hash(fixture.bytes), 'conversion writes a separate PDF asset');
    assert.deepEqual(
      originalAsset(hash(fixture.bytes)),
      fixture.bytes,
      'auto-conversion keeps incoming attachment bytes unchanged',
    );
    await inspectTextPdf(originalAsset(source.assetId), fixture, column.pages.length);
    await exportColumn(converted, column, index % 2 === 1, fixture);
  }
  await undoRedo(before, converted, `automatic ${label} conversion batch`);
  await assertOriginals();
  return converted;
}
async function reloadBoard() {
  await read('window.__composerBeforeReload=true');
  await renderer.send('Page.reload');
  await until(
    () => read('!window.__composerBeforeReload').catch(() => false),
    'renderer reload replaces the document',
  );
  await boardReady();
  await until(() => rect(composerSelector()), 'persisted composer remounts');
}
async function restoreHooks() {
  await releaseConversion();
  if (main)
    await main.read(`(() => {
    const state=globalThis.__pdfComposerDownloads;
    if(state)process.mainModule.require('electron').dialog.showSaveDialog=state.original;
  })()`);
}
async function closeChild() {
  await restoreHooks();
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  await main.read(`(() => {
    const {BrowserWindow}=process.mainModule.require('electron');
    const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('canvas-app:'));
    if(!window)throw Error('Expected isolated BrowserWindow');window.close();return true;
  })()`);
  renderer.close();
  main.close();
  renderer = undefined;
  main = undefined;
  let watchdog;
  try {
    const result = await Promise.race([
      exited,
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve(null), 20000);
      }),
    ]);
    assert.ok(result, 'native test-window close completes');
    assert.equal(result.code, 0);
  } finally {
    clearTimeout(watchdog);
  }
}
async function portableRoundtrip(expected) {
  const source = new Store(root),
    restored = new Store(join(root, 'portable-roundtrip'));
  try {
    const persisted = source.loadBoard({ id: board.id });
    assert.deepEqual(
      persisted.objects.find((object) => object.id === composerId),
      expected,
      'native app close preserves the complete composer frame',
    );
    // No loose source cards in this board: every original must be discovered
    // through pdfComposer.sources rather than another object's assetId.
    const only = source.createBoard({ name: 'Composer references only' });
    source.patchBoard({ id: only.id, revision: 0, upserts: [expected], deleted: [] });
    const bytes = await source.exportBoard({ id: only.id });
    writeFileSync(join(root, 'composer.canvasboard'), Buffer.from(bytes));
    const imported = await restored.importBoard({ bytes });
    const objects = restored.loadBoard({ id: imported.id }).objects;
    assert.deepEqual(
      objects,
      [expected],
      'portable board retains complete composer metadata and identities',
    );
    for (const entry of expected.pdfComposer.sources)
      assert.deepEqual(
        readFileSync(restored.asset({ id: entry.assetId, variant: 'original' }).file),
        originalAsset(entry.assetId),
        'portable board carries exact nested source original bytes',
      );
  } finally {
    source.close();
    restored.close();
  }
}

try {
  const mainTarget = await targetAt(inspectorPort, (target) => !!target.webSocketDebuggerUrl);
  main = await connect(mainTarget.webSocketDebuggerUrl, true);
  await main.send('Runtime.enable');
  await until(async () => {
    try {
      mainReadiness =
        await main.read(`({mainModule:typeof process.mainModule?.require, require:typeof require,
          electron:process.versions.electron, argv:process.argv})`);
      return mainReadiness.mainModule === 'function';
    } catch (error) {
      mainReadiness = { error: error.message };
      return false;
    }
  }, 'packaged main initializes');
  assert.equal(await main.read(`process.mainModule.require('electron').app.isPackaged`), true);
  await main.read(`(() => {
    const {dialog}=process.mainModule.require('electron');
    const fs=process.mainModule.require('node:fs'),path=process.mainModule.require('node:path');
    const state=globalThis.__pdfComposerDownloads={calls:[],cancelNext:false,original:dialog.showSaveDialog};
    dialog.showSaveDialog=async(...args)=>{
      const options=args.at(-1),canceled=state.cancelNext;state.cancelNext=false;
      const folder=path.join(process.env.CANVAS_DATA_DIR,'downloads',String(state.calls.length+1));
      fs.mkdirSync(folder,{recursive:true});
      const filePath=path.join(folder,path.basename(options.defaultPath));
      state.calls.push({defaultPath:options.defaultPath,filePath,canceled});
      return canceled?{canceled:true}:{canceled:false,filePath};
    };return true;
  })()`);
  const target = await targetAt(
    rendererPort,
    (target) => target.type === 'page' && target.url.startsWith('canvas-app:'),
  );
  renderer = await connect(target.webSocketDebuggerUrl, true);
  await renderer.send('Runtime.enable');
  await renderer.send('Page.enable');
  await renderer.send('Emulation.setDeviceMetricsOverride', {
    width: 1800,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await boardReady();
  await setAppearance('light');
  assert.equal(
    resolve(await read('window.canvas.dataDirectory()')),
    root,
    'all test state stays outside the real Library',
  );
  await saved(
    (document) =>
      document.objects
        .filter((object) => object.type === 'document')
        .every((object) => !!object.documentPreviewId),
    'source PDF previews finish before immutable snapshots',
  );
  originalObjects = snapshot((await state()).objects);
  const targetCard = originalObjects.find((object) => object.id === sourceCards[0].id);
  const draggedCard = originalObjects.find((object) => object.id === sourceCards[1].id);
  const from = await point(draggedCard, draggedCard.width / 2, draggedCard.height / 2);
  const to = await point(targetCard, targetCard.width / 2, targetCard.height / 2);
  await canvasHit(from, 'source PDF body receives native pointer input');
  await heldCreation(
    () =>
      nativeDrag(from, to, async () => {
        await until(
          () => rect('.pdf-composer-drop-target'),
          'PDF target feedback appears during native drag',
        );
        await shot('composer-drop-target');
      }),
    targetCard.assetId,
  );
  const createdBoard = await saved(
    (document) => document.objects.some((object) => object.pdfComposer),
    'PDF-on-PDF native drag creates composer',
  );
  const created = createdBoard.objects.find((object) => object.pdfComposer);
  composerId = created.id;
  assert.equal(created.type, 'frame');
  assert.equal(created.gallery, undefined);
  assert.equal(
    createdBoard.objects.length,
    originalObjects.length + 1,
    'composer creation preserves all source cards',
  );
  await until(() => rect(composerSelector()), 'on-board composer mounts');
  assert.equal(
    await read(`!!document.querySelector('.pdf-workspace')`),
    false,
    'composer opens on the board',
  );
  assert.deepEqual(
    created.pdfComposer.columns.map((column) => column.name),
    [fixtures.source.name, fixtures.merge.name],
  );
  assert.deepEqual(
    created.pdfComposer.columns.map((column) => column.pages.map((page) => page.pageIndex)),
    [
      [0, 1],
      [0, 1],
    ],
  );
  assert.deepEqual(
    created.pdfComposer.sources.map((source) => source.assetId),
    [targetCard.assetId, draggedCard.assetId],
  );
  await assertOriginals();
  await assertDomGraph();
  await read('document.activeElement?.blur()');
  await key('z', 'KeyZ', 2);
  await saved(
    (document) =>
      document.objects.length === originalObjects.length &&
      !document.objects.some((object) => object.pdfComposer),
    'one undo removes the new composer',
  );
  await assertOriginals();
  await key('z', 'KeyZ', 10);
  await expectGraph(created.pdfComposer, 'redo restores the same composer identities');
  await moveComposerBelowCards();
  await checkBorderMotion();
  await until(
    () =>
      read(`Array.from(document.querySelectorAll(${JSON.stringify(`${composerSelector()} .pdf-composer-page canvas`)}))
    .filter(canvas=>{
      if(!canvas.width || !canvas.height)return false;
      const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      let colored=0;for(let i=0;i<pixels.length;i+=256)
        if(pixels[i+3] && Math.max(pixels[i],pixels[i+1],pixels[i+2])-Math.min(pixels[i],pixels[i+1],pixels[i+2])>35)colored++;
      return colored>8;
    }).length>=4`),
    'four source page previews paint',
  );
  await shot('composer-light');
  checkpoint(
    'native PDF-on-PDF creates animated persistent frame; creation undo/redo and independent frame movement preserve originals',
  );

  await appendBoardCard(
    originalObjects.find((object) => object.id === sourceCards[2].id),
    3,
  );
  await appendBoardCard(
    originalObjects.find((object) => object.id === sourceCards[3].id),
    4,
  );
  const beforeExternal = snapshot(await graph());
  await nativeDrop([fixtures.external, fixtures.jpg], composerSelector());
  await saved(
    (document) =>
      document.objects.find((object) => object.id === composerId)?.pdfComposer.columns.length === 6,
    'native external PDF and image batch appends two columns',
  );
  const afterExternal = snapshot(await graph());
  assert.deepEqual(
    afterExternal.columns.slice(-2).map((column) => column.name),
    [fixtures.external.name, fixtures.jpg.name],
    'external file order becomes column order',
  );
  assert.deepEqual(
    afterExternal.columns.map((column) => column.pages.length),
    [2, 2, 2, 1, 1, 1],
  );
  await undoRedo(beforeExternal, afterExternal, 'external batch append');
  await assertOriginals();
  await rejectedDrop([fixtures.png, fixtures.malformed], 'malformed PDF batch');
  await rejectedDrop([fixtures.unsupported], 'unsupported attachment');
  checkpoint(
    'native board PDF/image and external file drops preserve originals; failed batches are atomic',
  );

  // Swap two pages within the first source column using the real pointer path.
  let before = snapshot(await graph()),
    expected = snapshot(before);
  const first = before.columns[0],
    second = before.columns[1];
  await watchMotion();
  await pageDrop(first.pages[0].id, first.id, first.pages[1].id, true);
  await assertMotion('page');
  expected.columns[0].pages.reverse();
  await expectGraph(expected, 'native within-column page reorder persists');
  await undoRedo(before, expected, 'within-column page move');
  await setAppearance('light', true);
  await watchMotion();
  await pageDrop(expected.columns[0].pages[0].id, first.id, expected.columns[0].pages[1].id, true);
  await expectGraph(before, 'reduced-motion pointer reorder still updates page order');
  await assertMotion('page', true);
  await key('z', 'KeyZ', 2);
  await expectGraph(expected, 'reduced-motion reorder undo restores edited order');
  await setAppearance('light');

  // Move BETA across into the second file before its first page; page identity
  // and immutable source reference must follow it rather than being copied.
  before = snapshot(await graph());
  expected = snapshot(before);
  const crossing = expected.columns[0].pages.shift();
  expected.columns[1].pages.unshift(crossing);
  await watchMotion();
  await pageDrop(crossing.id, second.id, before.columns[1].pages[0].id);
  await assertMotion('page');
  await expectGraph(expected, 'native cross-column page move preserves its identity');
  await undoRedo(before, expected, 'cross-column page move');

  await click(`${composerSelector()} [aria-label="New PDF column"]`);
  await saved(
    (document) =>
      document.objects.find((object) => object.id === composerId)?.pdfComposer.columns.length === 7,
    'new empty column persists',
  );
  let composition = await graph();
  const empty = composition.columns.at(-1);
  assert.equal(empty.pages.length, 0);
  const emptyExport = `${columnSelector(empty.id)} .pdf-composer-export`;
  assert.equal(
    await read(`document.querySelector(${JSON.stringify(emptyExport)}).disabled`),
    true,
    'empty column cannot export an empty PDF',
  );
  await bringIntoView(columnSelector(empty.id));
  await replaceText(`${columnSelector(empty.id)} [aria-label="PDF column name"]`, 'Draft.2026');
  await saved(
    (document) =>
      document.objects.find((object) => object.id === composerId)?.pdfComposer.columns.at(-1)
        ?.name === 'Draft.2026',
    'column rename preserves a dotted basename',
  );
  before = snapshot(await graph());
  expected = snapshot(before);
  const donor = expected.columns[5],
    imagePage = donor.pages.shift();
  expected.columns[6].pages.push(imagePage);
  await pageDrop(imagePage.id, empty.id);
  await expectGraph(expected, 'native page drop fills an empty column and leaves the donor empty');
  await undoRedo(before, expected, 'empty-column page move');

  // Bring two adjacent columns into view; reordering tests the real grip path.
  before = snapshot(await graph());
  expected = snapshot(before);
  const movingColumn = expected.columns.shift();
  expected.columns.splice(1, 0, movingColumn);
  await watchMotion();
  await columnDrop(before.columns[0].id, before.columns[1].id, true);
  await assertMotion('column');
  await expectGraph(expected, 'native column reorder persists without changing pages');
  await undoRedo(before, expected, 'column move');
  await assertOriginals();
  checkpoint(
    'native page and column sorting, cross-file movement, empty columns, rename and transactional undo/redo',
  );

  composition = snapshot(await graph());
  for (const [index, column] of composition.columns.entries()) {
    if (column.pages.length) await exportColumn(composition, column, index % 2 === 1);
    else
      assert.equal(
        await read(
          `document.querySelector(${JSON.stringify(`${columnSelector(column.id)} .pdf-composer-export`)}).disabled`,
        ),
        true,
      );
  }
  assert.deepEqual(
    await graph(),
    composition,
    'all exports leave the editable composition unchanged',
  );
  const cancelColumn = composition.columns.find((column) => column.pages.length);
  await bringIntoView(columnSelector(cancelColumn.id));
  const calls = await main.read('globalThis.__pdfComposerDownloads.calls.length');
  await main.read('globalThis.__pdfComposerDownloads.cancelNext=true');
  await click(`${columnSelector(cancelColumn.id)} .pdf-composer-export`);
  const canceled = await until(
    async () => (await main.read('globalThis.__pdfComposerDownloads.calls'))[calls],
    'canceled column download returns',
  );
  assert.equal(canceled.canceled, true);
  assert.equal(existsSync(canceled.filePath), false, 'native save cancellation writes no PDF');
  assert.deepEqual(await graph(), composition);
  checkpoint(
    'each nonempty column exports real vector PDFs in edited order and original rotation; dotted names and picker cancellation verified',
  );

  composition = await convertAttachments(
    [fixtures.docx, fixtures.text, fixtures.html],
    'DOCX/TXT/HTML',
  );
  checkpoint(
    'native DOCX/TXT/HTML auto-conversion preserves original bytes, Unicode text, multipage content and per-file columns',
  );
  if (officeFixtures.length) {
    composition = await convertAttachments(officeFixtures, 'DOC/XLS/PPT');
    checkpoint(
      'native legacy Office drops use the verified app-local engine and preserve exported text, page count and source bytes',
    );
  }

  await bringIntoView(columnSelector(composition.columns[0].id));
  await setAppearance('dark');
  await shot('composer-dark');
  const persisted = snapshot(await composer());
  await reloadBoard();
  assert.deepEqual(
    await composer(),
    persisted,
    'reload restores complete composer metadata and geometry',
  );
  await assertDomGraph();
  await assertOriginals();
  assert.deepEqual(errors, [], 'no uncaught renderer exceptions');
  await closeChild();
  await portableRoundtrip(persisted);
  checkpoint(
    'reload, native close and composer-only portable roundtrip preserve identities and every nested original asset',
  );
  completed = true;
  console.log('PDF_COMPOSER_DESKTOP_OK', JSON.stringify({ root, executable, steps, errors }));
} catch (error) {
  if (renderer) {
    try {
      await shot('failure');
    } catch {}
    try {
      writeFileSync(
        join(root, 'failure-state.json'),
        JSON.stringify(
          {
            board: await state(),
            dom: await read('document.body.innerText'),
            composer: await rect(composerRoot),
            activeElement: await read('document.activeElement?.outerHTML.slice(0,1000)'),
            inputEvents: await read('window.__composerInputEvents || []'),
            errors,
            downloads: main ? await main.read('globalThis.__pdfComposerDownloads?.calls') : [],
          },
          null,
          2,
        ),
      );
    } catch {}
  }
  console.error('PDF_COMPOSER_DESKTOP_FAILED', root, error);
  throw error;
} finally {
  writeFileSync(join(root, 'diagnostics.log'), diagnostics);
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify(
      {
        completed,
        steps,
        errors,
        executable,
        mainReadiness,
        officeFixtures: officeFixtures.map((fixture) => fixture.name),
      },
      null,
      2,
    ),
  );
  try {
    await restoreHooks();
  } catch {}
  renderer?.close();
  main?.close();
  // Only the exact child created by this harness can be terminated here.
  child.kill();
  if (child.exitCode === null)
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
}
