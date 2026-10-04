// Packaged document imports/readers, real pointer/keyboard interactions, and original downloads.
// Run after npm run package: node scripts/desktop-documents.mjs
// CANVAS_EXECUTABLE may point at another packaged build. All fixtures, downloads,
// screenshots and the test library stay in a unique repository-local .local-test folder.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  documentFixtures,
  editedDocumentText,
  originalDocumentText,
} from '../tests/document-fixtures.mjs';

const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-documents-'));
const fixtures = documentFixtures();
const store = new Store(root);
mkdirSync(join(root, 'fixtures'));
for (const fixture of fixtures) {
  fixture.path = join(root, 'fixtures', fixture.name);
  fixture.board = store.createBoard({ name: `Documents: ${fixture.key}` });
  writeFileSync(fixture.path, fixture.bytes);
}
const listFixture = { key: 'list', board: store.createBoard({ name: 'Documents: list scale' }) };
const seededList = {
  id: 'scaled-list',
  type: 'list',
  x: 400,
  y: 250,
  width: 320,
  height: 188,
  z: 1,
  text: 'Scaled tasks',
  items: [
    { id: 'first-task', text: 'First task', checked: false },
    { id: 'second-task', text: 'Second task', checked: false },
  ],
};
store.patchBoard({
  id: listFixture.board.id,
  revision: 0,
  upserts: [seededList],
  deleted: [],
  camera: { x: 0, y: 0, zoom: 1 },
});
const legacyListFixture = {
  key: 'legacy-list',
  board: store.createBoard({ name: 'Documents: legacy list' }),
};
const legacyList = {
  ...seededList,
  id: 'legacy-wide-list',
  x: 350,
  width: 640,
  height: 188,
  text: 'Legacy wide list',
  items: [
    { id: 'legacy-first', text: 'Legacy first row stays visible', checked: false },
    { id: 'legacy-second', text: 'Legacy second row stays visible', checked: false },
  ],
};
store.patchBoard({
  id: legacyListFixture.board.id,
  revision: 0,
  upserts: [legacyList],
  deleted: [],
  camera: { x: 0, y: 0, zoom: 1 },
});
store.setLastBoard({ id: fixtures[0].board.id });
store.close();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const rendererPort = await freePort();
const inspectorPort = await freePort();
const env = { ...process.env, CANVAS_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const executable = process.env.CANVAS_EXECUTABLE || resolve('release/win-unpacked/Terra Board.exe');
assert.ok(existsSync(executable), `Package Terra Board first: ${executable}`);
const child = spawn(
  executable,
  [`--remote-debugging-port=${rendererPort}`, `--inspect=127.0.0.1:${inspectorPort}`],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let diagnostics = '',
  launchError;
child.on('error', (error) => {
  launchError = error;
});
child.stderr.on('data', (data) => {
  diagnostics += data;
});
child.stdout.on('data', (data) => {
  diagnostics += data;
});
const errors = [],
  steps = [];
let renderer,
  main,
  active = fixtures[0],
  completed = false;

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
    contexts = new Map();
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
          ? request.reject(Error(message.error.message))
          : request.resolve(message.result);
      }
    } else if (message.method === 'Runtime.exceptionThrown' && reportErrors) {
      errors.push(
        message.params.exceptionDetails.exception?.description ||
          message.params.exceptionDetails.text,
      );
    } else if (message.method === 'Runtime.executionContextCreated') {
      contexts.set(message.params.context.id, message.params.context);
    } else if (message.method === 'Runtime.executionContextDestroyed') {
      contexts.delete(message.params.executionContextId);
    } else if (message.method === 'Runtime.executionContextsCleared') contexts.clear();
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          Error(
            `CDP timed out: ${method}${method.startsWith('Input.') ? ' ' + JSON.stringify(params) : ''}`,
          ),
        );
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return {
    send,
    contexts,
    async read(expression, extra = {}, sessionId) {
      const result = await send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, ...extra },
        sessionId,
      );
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
const state = (fixture = active) =>
  read(`window.canvas.invoke('loadBoard', {id:${JSON.stringify(fixture.board.id)}})`);
const object = async (id, fixture = active) =>
  (await state(fixture)).objects.find((item) => item.id === id);
async function saved(test, label, fixture = active) {
  return until(async () => {
    const document = await state(fixture);
    return test(document) ? document : null;
  }, label);
}
const rect = (selector) =>
  read(`(() => {
  const element=document.querySelector(${JSON.stringify(selector)});
  if(!element)return null;
  const r=element.getBoundingClientRect();
  return {x:r.x,y:r.y,width:r.width,height:r.height};
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
  // Canvas controls mount before the canvas frame positions them. Hidden
  // elements still have bounds; wait until the actual pointer will hit them.
  let previous;
  const r = await until(async () => {
    const current = await read(`(() => {
      const element=document.querySelector(${JSON.stringify(selector)});
      if(!element || element.disabled)return null;
      const r=element.getBoundingClientRect(),style=getComputedStyle(element);
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      if(r.width<=0 || r.height<=0 || style.visibility!=='visible' || style.display==='none'
        || !hit || !(element===hit || element.contains(hit)))return null;
      return {x:r.x,y:r.y,width:r.width,height:r.height};
    })()`);
    const settled =
      current &&
      previous &&
      ['x', 'y', 'width', 'height'].every((key) => Math.abs(current[key] - previous[key]) < 0.5);
    previous = current;
    return settled ? current : null;
  }, `${selector} is stable and accepts pointer input`);
  await clickPoint({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
}
async function key(key, code, modifiers = 0) {
  const windowsVirtualKeyCode = code.startsWith('Key')
    ? code.charCodeAt(3)
    : { Enter: 13, Escape: 27, Tab: 9, Delete: 46 }[code] || 0;
  for (const type of ['keyDown', 'keyUp'])
    await renderer.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      modifiers,
      windowsVirtualKeyCode,
    });
}
async function settleCamera() {
  const zoom = await read(`parseFloat(document.querySelector('.zoom-value').textContent)`);
  return until(async () => {
    const camera = (await state()).camera;
    return Math.round(camera.zoom * 100) === zoom ? camera : null;
  }, 'camera persisted');
}
async function point(item, dx = item.width / 2, dy = Math.min(28, item.height / 2)) {
  const camera = await settleCamera(),
    host = await rect('.canvas-surface');
  return {
    x: host.x + (item.x + dx) * camera.zoom + camera.x,
    y: host.y + (item.y + dy) * camera.zoom + camera.y,
  };
}
async function select(item) {
  await key('Escape', 'Escape');
  await clickPoint(await point(item, 12, 12));
  await until(
    () => rect('.selection-tools [aria-label="Duplicate selection"]'),
    'document selected by pointer',
  );
}
async function drag(from, to) {
  await mouse('mouseMoved', from, 'left', 1, 0);
  await mouse('mousePressed', from);
  for (let i = 1; i <= 6; i++)
    await mouse('mouseMoved', {
      x: from.x + ((to.x - from.x) * i) / 6,
      y: from.y + ((to.y - from.y) * i) / 6,
    });
  await mouse('mouseReleased', to);
}
async function menu(label) {
  const target = await until(
    () =>
      read(`(() => {
    const element=[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.trim()===${JSON.stringify(label)});
    if(!element)return null;const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`),
    `context item ${label}`,
  );
  await clickPoint(target);
}
async function shot(name) {
  const { data } = await renderer.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, `${name}.png`), Buffer.from(data, 'base64'));
}
function checkpoint(name) {
  steps.push(name);
  console.log('DOCUMENT_CHECK', name);
}
async function noError() {
  assert.equal(await read(`document.querySelector('.error-banner')?.textContent || ''`), '');
}
async function openBoard(fixture) {
  if (fixture !== active) {
    if (await read(`document.querySelector('.app-shell').hasAttribute('data-panel-hidden')`))
      await click('[aria-label="Show board panel"]');
    await click(`[aria-label="Open board ${fixture.board.name}"]`);
    active = fixture;
  }
  await until(
    () =>
      read(
        `document.querySelector('.board-title')?.textContent===${JSON.stringify(fixture.board.name)}
          && !!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading')`,
      ),
    `${fixture.key} canvas ready`,
  );
}
async function importFixture(fixture) {
  await openBoard(fixture);
  const host = await rect('.canvas-surface');
  const dropPoint = { x: host.x + host.width * 0.47, y: host.y + host.height * 0.5 };
  for (const type of ['dragEnter', 'dragOver', 'drop'])
    await renderer.send('Input.dispatchDragEvent', {
      type,
      ...dropPoint,
      data: { items: [], files: [fixture.path], dragOperationsMask: 1 },
    });
  const document = await saved(
    (document) =>
      document.objects.some((item) => item.type === 'document' && item.text === fixture.name),
    `${fixture.name} imported as document`,
  );
  fixture.object = document.objects.find(
    (item) => item.type === 'document' && item.text === fixture.name,
  );
  assert.match(fixture.object.assetId, /^[a-f0-9]{64}$/);
  assert.equal(
    fixture.object.assetId,
    createHash('sha256').update(fixture.bytes).digest('hex'),
    'original asset bytes are content addressed',
  );
  assert.equal(fixture.object.documentTitle || '', '', 'separate title starts empty');
  await noError();
  checkpoint(`native drop: ${fixture.name}`);
  return fixture.object;
}
async function openReader(item, kind, doubleClick = false) {
  await select(item);
  if (doubleClick) {
    // Copies are offset over the source. Use its exposed top-left body, just
    // as selection does, so a double click cannot hit a later pasted card.
    const p = await point(item, 12, 12);
    await clickPoint(p);
    await clickPoint(p, 'left', 2);
  } else await click('.selection-tools [aria-label="Preview document"]');
  const selector = `.document-reader[data-document-id="${item.id}"][data-kind="${kind}"]`;
  await until(() => rect(selector), `${kind} on-board reader`);
  if (kind === 'text')
    await until(
      () => rect(`${selector} [aria-label="Edit document text"]`),
      'document text loaded',
    );
  assert.equal(
    await read(`!!document.querySelector('.modal-backdrop')`),
    false,
    'document reader stays on the board',
  );
  return selector;
}
async function closeReader() {
  if (await rect('.document-reader')) await click('.document-reader [aria-label="Close document"]');
  await until(() => read(`!document.querySelector('.document-reader')`), 'document reader closed');
}
async function replaceText(selector, text) {
  await click(selector);
  await key('a', 'KeyA', 2);
  await renderer.send('Input.insertText', { text });
  assert.equal(await read(`document.querySelector(${JSON.stringify(selector)}).value`), text);
}
async function download(item, expected, context = false) {
  await select(item);
  const count = await main.read('globalThis.__documentDownloadTest.calls.length');
  if (context) {
    await clickPoint(await point(item, 12, 12), 'right');
    await menu('Download');
  } else await click('.selection-tools [aria-label="Download document"]');
  const entry = await until(
    async () => {
      const calls = await main.read('globalThis.__documentDownloadTest.calls');
      const call = calls[count];
      return call && existsSync(call.filePath) && statSync(call.filePath).size === expected.length
        ? call
        : null;
    },
    `${item.text} downloaded through ${context ? 'context menu' : 'ribbon'}`,
  );
  assert.equal(
    basename(entry.defaultPath),
    item.text,
    'download suggests original filename, independently of title',
  );
  assert.equal(basename(entry.filePath), item.text);
  assert.deepEqual(
    readFileSync(entry.filePath),
    expected,
    'download writes the exact original/edited bytes',
  );
  return entry;
}
async function pdfPaint(color) {
  return until(
    () =>
      read(`(() => {
    const canvas=document.querySelector('.document-reader canvas');
    if(!canvas?.width || !canvas.height)return false;
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    let colored=0;
    for(let i=0;i<pixels.length;i+=64){
      const red=pixels[i], blue=pixels[i+2];
      if(pixels[i+3]>0 && ${color === 'red' ? 'red > blue + 70' : 'blue > red + 70'})colored++;
    }
    return colored>30;
  })()`),
    `PDF ${color} page pixels rendered`,
  );
}
async function docxText() {
  const frameTree = (await renderer.send('Page.getFrameTree')).frameTree;
  const frames = [];
  const visit = (tree) => {
    frames.push(tree.frame);
    (tree.childFrames || []).forEach(visit);
  };
  visit(frameTree);
  const frame = frames.find((frame) => frame.url === 'about:srcdoc');
  const context = [...renderer.contexts.values()].find(
    (context) => context.auxData?.frameId === frame?.id && context.auxData?.isDefault,
  );
  if (context) return renderer.read('document.body.innerText', { contextId: context.id });
  const targets = (await renderer.send('Target.getTargets')).targetInfos;
  const target = targets.find(
    (target) =>
      target.type === 'iframe' && (target.targetId === frame?.id || target.url === 'about:srcdoc'),
  );
  if (!target) return null;
  const { sessionId } = await renderer.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  try {
    return await renderer.read('document.body.innerText', {}, sessionId);
  } finally {
    await renderer.send('Target.detachFromTarget', { sessionId });
  }
}
async function listMetrics() {
  return read(`(() => {
    const list=document.querySelector('.canvas-list'), rows=[...list.querySelectorAll('.canvas-list-row')];
    const checkbox=list.querySelector('.canvas-list-circle').getBoundingClientRect();
    const input=rows[0].querySelector('input'), text=input.getBoundingClientRect();
    const transform=new DOMMatrix(getComputedStyle(list).transform);
    return {
      width:list.getBoundingClientRect().width,
      checkbox:checkbox.width,
      textHeight:text.height,
      visibleFont:parseFloat(getComputedStyle(input).fontSize)*Math.hypot(transform.a,transform.b),
      spacing:rows[1].getBoundingClientRect().top-rows[0].getBoundingClientRect().top,
    };
  })()`);
}

run: try {
  const mainTarget = await targetAt(inspectorPort, (target) => !!target.webSocketDebuggerUrl);
  main = await connect(mainTarget.webSocketDebuggerUrl);
  await main.send('Runtime.enable');
  await until(
    () =>
      main
        .read(`typeof process!=='undefined' && typeof process.mainModule?.require==='function'`)
        .catch(() => false),
    'packaged main module initialized',
  );
  assert.equal(
    await main.read(`process.mainModule.require('electron').app.isPackaged`),
    true,
    'test uses the packaged main process',
  );
  // Only the test process is patched. Native dialog choices are deterministic,
  // while the production download IPC handler performs the actual file write.
  await main.read(`(() => {
    const {dialog}=process.mainModule.require('electron');
    const fs=process.mainModule.require('node:fs'), path=process.mainModule.require('node:path');
    const state=globalThis.__documentDownloadTest={calls:[],original:dialog.showSaveDialog};
    dialog.showSaveDialog=async (...args) => {
      const options=args.at(-1), folder=path.join(process.env.CANVAS_DATA_DIR,'downloads',String(state.calls.length+1));
      fs.mkdirSync(folder,{recursive:true});
      const filePath=path.join(folder,path.basename(options.defaultPath));
      state.calls.push({defaultPath:options.defaultPath,filePath});
      return {canceled:false,filePath};
    };
    return true;
  })()`);
  const target = await targetAt(
    rendererPort,
    (target) => target.type === 'page' && target.url.startsWith('canvas-app:'),
  );
  renderer = await connect(target.webSocketDebuggerUrl, true);
  await renderer.send('Runtime.enable');
  await renderer.send('Page.enable');
  await read(`(() => {
    window.__documentInputEvents=[];
    for(const type of ['pointerdown','pointerup','click','focusin','focusout'])
      document.addEventListener(type,event=>{
        const element=event.target.closest?.('button,input,textarea,.canvas-list,.canvas-surface');
        window.__documentInputEvents.push({type,label:element?.getAttribute('aria-label'),tag:element?.tagName,
          x:event.clientX,y:event.clientY,editor:!!document.querySelector('textarea[aria-label="Edit document title"]')});
        if(window.__documentInputEvents.length>200)window.__documentInputEvents.shift();
      },true);
  })()`);
  await renderer.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await openBoard(active);
  assert.equal(
    resolve(await read('window.canvas.dataDirectory()')),
    root,
    'test data is isolated from the real Library',
  );
  await importFixture(active);
  let original = active.object;

  await select(original);
  const ribbon = await read(
    `[...document.querySelectorAll('.selection-tools button')].map(button=>button.getAttribute('aria-label'))`,
  );
  const downloadIndex = ribbon.indexOf('Download document'),
    duplicateIndex = ribbon.indexOf('Duplicate selection');
  assert.ok(
    downloadIndex >= 0 && Math.abs(downloadIndex - duplicateIndex) === 1,
    'Download is adjacent to Duplicate in the selection ribbon',
  );
  await click('.selection-tools [aria-label="Add title"]');
  await replaceText(
    'textarea[aria-label="Edit document title"]',
    'Research notes — separate title',
  );
  await key('Enter', 'Enter', 2);
  await saved(
    (document) =>
      document.objects.find((item) => item.id === original.id)?.documentTitle ===
      'Research notes — separate title',
    'document title saved separately',
  );
  original = await object(original.id);
  assert.equal(original.text, active.name);
  assert.equal(original.assetId, active.object.assetId);
  if (process.argv.includes('--title-probe')) {
    writeFileSync(
      join(root, 'title-input-events.json'),
      JSON.stringify(await read('window.__documentInputEvents'), null, 2),
    );
    await shot('title-probe');
    completed = true;
    console.log('DOCUMENT_TITLE_PROBE_OK', root);
    break run;
  }
  await download(original, active.bytes);
  await download(original, active.bytes, true);
  checkpoint('separate title, adjacent ribbon action, and exact ribbon/context downloads');

  // Exercise every visible corner with actual Chromium pointer events.
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    await select(original);
    const camera = await settleCamera(),
      west = corner.includes('w'),
      north = corner.includes('n');
    const from = await point(original, west ? 0 : original.width, north ? 0 : original.height);
    await drag(from, {
      x: from.x + (west ? -1 : 1) * 42 * camera.zoom,
      y: from.y + (north ? -1 : 1) * 36 * camera.zoom,
    });
    const resized = (
      await saved(
        (document) =>
          document.objects.find((item) => item.id === original.id).width > original.width + 20,
        `${corner} resized`,
      )
    ).objects.find((item) => item.id === original.id);
    assert.ok(resized.height > original.height + 15, `${corner} changes height`);
    assert.ok(
      Math.abs(
        resized.x + (west ? resized.width : 0) - (original.x + (west ? original.width : 0)),
      ) < 1,
      `${corner} opposite horizontal edge remains fixed`,
    );
    assert.ok(
      Math.abs(
        resized.y + (north ? resized.height : 0) - (original.y + (north ? original.height : 0)),
      ) < 1,
      `${corner} opposite vertical edge remains fixed`,
    );
    await key('z', 'KeyZ', 2);
    await saved(
      (document) =>
        document.objects.find((item) => item.id === original.id).width === original.width,
      `${corner} resize undo`,
    );
  }
  checkpoint('four resize corners preserve opposite edges and undo');
  const zoomBefore = await settleCamera();
  await click('.canvas-zoom [aria-label="Zoom in"]');
  await saved(
    (document) => document.camera.zoom > zoomBefore.zoom + 0.1,
    'document zoom persisted',
  );
  await sleep(300);
  const zoomAfter = await settleCamera();
  assert.equal(
    (await object(original.id)).width,
    original.width,
    'zoom does not change document geometry',
  );
  const zoomFrom = await point(original, original.width, original.height);
  await drag(zoomFrom, {
    x: zoomFrom.x + 32 * zoomAfter.zoom,
    y: zoomFrom.y + 28 * zoomAfter.zoom,
  });
  await saved(
    (document) =>
      document.objects.find((item) => item.id === original.id).width > original.width + 20,
    'corner resize at non-unit zoom',
  );
  await key('z', 'KeyZ', 2);
  await saved(
    (document) => document.objects.find((item) => item.id === original.id).width === original.width,
    'zoomed resize undo',
  );
  await click('.canvas-zoom [aria-label="Zoom out"]');
  await saved(
    (document) => Math.abs(document.camera.zoom - zoomBefore.zoom) < 0.01,
    'zoom restored',
  );
  checkpoint('four resize corners, fixed opposite edges, undo, and zoomed resize');

  original = await object(original.id);
  await select(original);
  await click('.selection-tools [aria-label="Duplicate selection"]');
  const duplicated = await saved(
    (document) => document.objects.length === 2,
    'document duplicated',
  );
  const duplicate = duplicated.objects.find((item) => item.id !== original.id);
  for (const field of [
    'type',
    'text',
    'assetId',
    'documentTitle',
    'documentMime',
    'documentBytes',
    'documentExcerpt',
    'documentPreviewId',
  ])
    assert.equal(duplicate[field], original[field], `duplicate preserves ${field}`);
  // Move the duplicate clear of the original before revisiting either card.
  const moveFrom = await point(duplicate, duplicate.width / 2, 24),
    moveCamera = await settleCamera();
  await drag(moveFrom, {
    x: moveFrom.x + (duplicate.width + 100) * moveCamera.zoom,
    y: moveFrom.y,
  });
  await saved(
    (document) =>
      document.objects.find((item) => item.id === duplicate.id).x > duplicate.x + duplicate.width,
    'duplicate moved independently',
  );
  await select(original);
  await key('c', 'KeyC', 2);
  const clipboard = await until(async () => {
    const items = await read('window.canvas.clipboardObjects()');
    return Array.isArray(items) && items.length === 1 && items[0].id === original.id ? items : null;
  }, 'native document clipboard');
  assert.equal(clipboard[0].documentTitle, original.documentTitle);
  assert.equal(clipboard[0].assetId, original.assetId);
  const pasteAt = await point(original, original.width / 2, original.height + 160);
  await mouse('mouseMoved', pasteAt, 'left', 1, 0);
  await key('v', 'KeyV', 2);
  const pastedDocument = await saved(
    (document) => document.objects.length === 3,
    'native document paste',
  );
  const pasted = pastedDocument.objects.find(
    (item) => ![original.id, duplicate.id].includes(item.id),
  );
  assert.equal(pasted.assetId, original.assetId);
  assert.equal(pasted.documentTitle, original.documentTitle);
  assert.equal(pasted.text, original.text);
  await key('z', 'KeyZ', 2);
  await saved((document) => document.objects.length === 2, 'paste undo');
  await key('z', 'KeyZ', 10);
  await saved((document) => document.objects.some((item) => item.id === pasted.id), 'paste redo');
  checkpoint('duplicate, native clipboard, undo, and redo preserve document metadata');

  await openReader(original, 'text', true);
  assert.equal(
    await read(`document.querySelector('[aria-label="Edit document text"]').value`),
    originalDocumentText,
  );
  await replaceText('[aria-label="Edit document text"]', editedDocumentText);
  await click('.document-reader [aria-label="Save document"]');
  await saved(
    (document) =>
      document.objects.find((item) => item.id === original.id).assetId !== original.assetId,
    'TXT save writes a new original asset',
  );
  let edited = await object(original.id);
  assert.equal(
    (await object(duplicate.id)).assetId,
    original.assetId,
    'editing keeps duplicate bytes unchanged',
  );
  assert.equal(
    (await object(pasted.id)).assetId,
    original.assetId,
    'editing keeps clipboard copy bytes unchanged',
  );
  assert.equal(edited.text, original.text);
  assert.equal(edited.documentTitle, original.documentTitle);
  await closeReader();
  await download(edited, Buffer.from(editedDocumentText));
  await select(edited);
  await key('z', 'KeyZ', 2);
  await saved(
    (document) =>
      document.objects.find((item) => item.id === original.id).assetId === original.assetId,
    'text edit undo restores original bytes',
  );
  await key('z', 'KeyZ', 10);
  await saved(
    (document) =>
      document.objects.find((item) => item.id === original.id).assetId === edited.assetId,
    'text edit redo restores edited bytes',
  );
  await openReader(edited, 'text');
  const secondText = `${editedDocumentText}Saved with Ctrl+Enter.\n`;
  await replaceText('[aria-label="Edit document text"]', secondText);
  await key('Enter', 'Enter', 2);
  await saved(
    (document) =>
      document.objects.find((item) => item.id === original.id).assetId !== edited.assetId,
    'Ctrl+Enter saves text',
  );
  await closeReader();
  edited = await object(original.id);
  await download(edited, Buffer.from(secondText));
  await download(await object(duplicate.id), active.bytes);
  active.expectedText = secondText;
  active.object = edited;
  await shot('text-documents');
  checkpoint(
    'Unicode TXT reading/editing, save button, Ctrl+Enter, independent duplicates, edit undo/redo',
  );

  // Search flushes the dirty reader before committing the simultaneous title
  // editor. The title draft must not restore the old document asset snapshot.
  await openReader(edited, 'text');
  const concurrentText = `${secondText}Body and title saved together through search.\n`;
  const concurrentTitle = 'Concurrent title preserves document edits';
  await replaceText('[aria-label="Edit document text"]', concurrentText);
  await click('.selection-tools [aria-label="Edit title"]');
  await replaceText('textarea[aria-label="Edit document title"]', concurrentTitle);
  await key('k', 'KeyK', 2);
  await until(() => rect('.library-search'), 'Ctrl+K flushes both document editors');
  const concurrent = (
    await saved((document) => {
      const item = document.objects.find((item) => item.id === edited.id);
      return (
        item.documentTitle === concurrentTitle &&
        item.assetId === createHash('sha256').update(Buffer.from(concurrentText)).digest('hex')
      );
    }, 'title commit retains the newly saved text asset')
  ).objects.find((item) => item.id === edited.id);
  assert.equal(concurrent.text, edited.text, 'concurrent editors preserve original filename');
  assert.equal(concurrent.documentExcerpt, concurrentText);
  for (const field of ['x', 'y', 'width', 'height'])
    assert.equal(concurrent[field], edited[field], `concurrent editors preserve ${field}`);
  assert.equal((await object(duplicate.id)).assetId, original.assetId);
  await click('.modal [aria-label="Close dialog"]');
  await closeReader();
  await download(concurrent, Buffer.from(concurrentText));
  await openReader(concurrent, 'text');
  assert.equal(
    await read(`document.querySelector('[aria-label="Edit document text"]').value`),
    concurrentText,
  );
  await closeReader();
  active.expectedText = concurrentText;
  active.object = concurrent;
  checkpoint('dirty TXT body and title both survive the Ctrl+K save flush and exact download');

  // Keep the real renderer bridge and persistence handler. Delay only the next
  // matching board patch so the UI must survive its asynchronous save boundary.
  await main.read(`(() => {
    const {ipcMain}=process.mainModule.require('electron');
    const original=ipcMain._invokeHandlers?.get('canvas:invoke');
    if(typeof original!=='function')throw Error('The document save probe cannot find the real IPC handler.');
    const gate=globalThis.__documentSaveDelay={original,armed:true,started:0,released:0,completed:0,watchdogFired:false};
    ipcMain.removeHandler('canvas:invoke');
    ipcMain.handle('canvas:invoke',async(event,command,args)=>{
      const hold=gate.armed && command==='patchBoard'
        && args?.upserts?.some(item=>item.id===${JSON.stringify(concurrent.id)});
      if(hold){
        gate.armed=false;gate.started=Date.now();
        await new Promise(resolve=>{
          gate.release=()=>{if(gate.released)return;clearTimeout(gate.watchdog);gate.released=Date.now();resolve();};
          gate.watchdog=setTimeout(()=>{gate.watchdogFired=true;gate.release();},10000);
        });
      }
      const result=await original(event,command,args);
      if(hold)gate.completed=Date.now();
      return result;
    });
    return true;
  })()`);
  await openReader(concurrent, 'text');
  const pendingText = `${concurrentText}Saved while another document preview is requested.\n`;
  await replaceText('[aria-label="Edit document text"]', pendingText);
  await read(`(() => {
    window.__pendingDocumentReader=document.querySelector('.document-reader');
    window.__pendingDocumentEditor=document.querySelector('[aria-label="Edit document text"]');
  })()`);
  await click('.document-reader [aria-label="Save document"]');
  await until(
    () => main.read('globalThis.__documentSaveDelay.started>0'),
    'document save reaches delayed persistence',
  );
  const assertPendingReader = async () => {
    assert.deepEqual(
      await read(`({
      sameReader:document.querySelector('.document-reader')===window.__pendingDocumentReader,
      sameEditor:document.querySelector('[aria-label="Edit document text"]')===window.__pendingDocumentEditor,
      disabled:document.querySelector('[aria-label="Edit document text"]')?.disabled,
      value:document.querySelector('[aria-label="Edit document text"]')?.value,
    })`),
      { sameReader: true, sameEditor: true, disabled: true, value: pendingText },
      'pending save retains its disabled editor instead of mounting an editable replacement',
    );
  };
  await assertPendingReader();
  await sleep(1000);
  assert.equal(
    await main.read('globalThis.__documentSaveDelay.released'),
    0,
    'save gate is still held',
  );
  await assertPendingReader();
  const nextDocument = await object(duplicate.id);
  const nextPoint = await point(nextDocument, nextDocument.width / 2, nextDocument.height / 2);
  await clickPoint(nextPoint);
  await clickPoint(nextPoint, 'left', 2);
  assert.equal(
    await main.read('globalThis.__documentSaveDelay.released'),
    0,
    'save stays gated through the second-document request',
  );
  await assertPendingReader();
  await main.read('globalThis.__documentSaveDelay.release()');
  await until(
    () => main.read('globalThis.__documentSaveDelay.completed>0'),
    'delayed document patch completes',
  );
  await until(
    () =>
      read(`document.querySelector('.document-reader')?.dataset.documentId===${JSON.stringify(duplicate.id)}
      && !!document.querySelector('[aria-label="Edit document text"]')`),
    'requested second document reader opens after pending save',
  );
  await sleep(250);
  assert.deepEqual(
    await read(`({
    id:document.querySelector('.document-reader')?.dataset.documentId,
    value:document.querySelector('[aria-label="Edit document text"]')?.value,
    disabled:document.querySelector('[aria-label="Edit document text"]')?.disabled,
  })`),
    { id: duplicate.id, value: originalDocumentText, disabled: false },
    'the old save completion cannot close or replace the newly opened document reader',
  );
  const gateTiming = await main.read(`({started:globalThis.__documentSaveDelay.started,
    released:globalThis.__documentSaveDelay.released,completed:globalThis.__documentSaveDelay.completed,
    watchdogFired:globalThis.__documentSaveDelay.watchdogFired})`);
  assert.equal(
    gateTiming.watchdogFired,
    false,
    'test explicitly releases persistence before the watchdog',
  );
  assert.ok(
    gateTiming.released - gateTiming.started >= 950,
    'persistence was delayed for one second',
  );
  await main.read(`(() => {
    const {ipcMain}=process.mainModule.require('electron'),gate=globalThis.__documentSaveDelay;
    ipcMain.removeHandler('canvas:invoke');ipcMain.handle('canvas:invoke',gate.original);gate.restored=true;
  })()`);
  await closeReader();
  const pendingSaved = await object(concurrent.id);
  assert.equal(
    pendingSaved.assetId,
    createHash('sha256').update(Buffer.from(pendingText)).digest('hex'),
  );
  await download(pendingSaved, Buffer.from(pendingText));
  active.expectedText = pendingText;
  active.object = pendingSaved;
  checkpoint('delayed save keeps its editor disabled and cannot close the next document reader');

  for (const fixture of fixtures.slice(1)) {
    const item = await importFixture(fixture);
    await download(item, fixture.bytes);
    await openReader(item, fixture.kind);
    if (fixture.key === 'pdf') {
      const previewed = (
        await saved(
          (document) =>
            !!document.objects.find((object) => object.id === item.id).documentPreviewId,
          'PDF card preview asset saved',
        )
      ).objects.find((object) => object.id === item.id);
      assert.match(previewed.documentPreviewId, /^[a-f0-9]{64}$/);
      assert.equal(previewed.documentPageCount, 2, 'PDF page count persists with preview metadata');
      await until(
        () => read(`document.querySelector('.document-page-number')?.textContent.trim()==='1 / 2'`),
        'PDF two-page count',
      );
      await pdfPaint('red');
      assert.equal(
        await read(`(() => {
        const page=document.querySelector('.document-pdf-page');
        return page.scrollWidth<=page.clientWidth;
      })()`),
        true,
        'PDF fits its reader width at 100% without horizontal scrolling',
      );
      await shot('pdf-page-one');
      await click('.document-reader [aria-label="Next page"]');
      await until(
        () => read(`document.querySelector('.document-page-number')?.textContent.trim()==='2 / 2'`),
        'PDF next page',
      );
      await pdfPaint('blue');
      await shot('pdf-page-two');
      await click('.document-reader [aria-label="Previous page"]');
      await until(
        () => read(`document.querySelector('.document-page-number')?.textContent.trim()==='1 / 2'`),
        'PDF previous page',
      );
      await pdfPaint('red');
    } else if (fixture.key === 'malformed') {
      await until(
        () =>
          read(
            `document.querySelector('.document-reader-message')?.textContent.includes('could not be previewed')`,
          ),
        'damaged PDF shows a bounded fallback',
        15000,
      );
      assert.equal(
        (await object(item.id)).assetId,
        item.assetId,
        'failed preview retains original attachment',
      );
      assert.equal(await read(`!!document.querySelector('.document-reader canvas')`), false);
      await shot('damaged-pdf-fallback');
      await closeReader();
      await download(await object(item.id), fixture.bytes);
    } else if (fixture.key === 'docx') {
      await until(
        () => rect('.document-reader iframe[title="Word document preview"]'),
        'Word preview iframe',
      );
      const text = await until(async () => {
        const text = await docxText();
        return text?.includes('Terra DOCX fixture') ? text : null;
      }, 'DOCX text rendered in sandboxed preview');
      assert.match(text, /café, 日本語, українська/);
      await saved(
        (document) =>
          document.objects
            .find((object) => object.id === item.id)
            .documentExcerpt?.includes('Terra DOCX fixture'),
        'DOCX card excerpt persisted',
      );
      const sandbox = await read(
        `document.querySelector('.document-reader iframe').getAttribute('sandbox')`,
      );
      assert.ok(!sandbox.includes('allow-same-origin'), 'Word preview remains sandboxed');
      await shot('word-preview');
    } else if (fixture.key === 'empty') {
      assert.equal(
        await read(`document.querySelector('[aria-label="Edit document text"]').value`),
        '',
        'empty TXT opens as editable empty text',
      );
    } else {
      assert.ok(
        (await rect('.document-reader')).width > 100,
        'generic attachment has a readable local reader',
      );
    }
    await closeReader();
    await noError();
    checkpoint(`${fixture.key} preview and exact original download`);
  }

  await openBoard(legacyListFixture);
  await until(() => rect('.canvas-list[data-list-id="legacy-wide-list"]'), 'legacy wide list');
  const legacyBounds = await read(`(() => {
    const list=document.querySelector('.canvas-list'), items=list.querySelector('.canvas-list-items');
    const card=list.getBoundingClientRect(),viewport=items.getBoundingClientRect();
    return {
      width:card.width,height:card.height,scale:Number(list.dataset.listScale),
      viewport:{top:viewport.top,bottom:viewport.bottom},
      scrollHeight:items.scrollHeight,clientHeight:items.clientHeight,
      rows:[...items.querySelectorAll('.canvas-list-row')].map(row=>{
        const r=row.getBoundingClientRect();return {top:r.top,bottom:r.bottom,text:row.querySelector('input').value};
      }),
    };
  })()`);
  assert.equal(legacyBounds.width, 640, 'legacy list retains its saved width');
  assert.equal(legacyBounds.height, 188, 'legacy list retains its saved height');
  assert.equal(legacyBounds.scale, 1, 'legacy horizontal stretch does not enlarge its content');
  assert.equal(legacyBounds.rows.length, 2);
  assert.ok(
    legacyBounds.scrollHeight <= legacyBounds.clientHeight + 1,
    'legacy rows require no scroll',
  );
  for (const row of legacyBounds.rows)
    assert.ok(
      row.top >= legacyBounds.viewport.top - 1 && row.bottom <= legacyBounds.viewport.bottom + 1,
      `${row.text} stays inside the visible card`,
    );
  assert.deepEqual(
    (await state()).objects,
    [legacyList],
    'opening legacy list does not rewrite geometry',
  );
  await shot('legacy-wide-list');
  await select(legacyList);
  const exportDialogCount = await main.read('globalThis.__documentDownloadTest.calls.length');
  await clickPoint(await point(legacyList, 12, 12), 'right');
  await menu('Export selected…');
  await click('[data-quality="full"]');
  await click('.export-formats button:first-child');
  await until(() => rect('.export-actions'), 'legacy list PNG exported');
  const exportedList = (await main.read('globalThis.__documentDownloadTest.calls'))[
    exportDialogCount
  ];
  assert.ok(exportedList && existsSync(exportedList.filePath));
  const pixels = await sharp(exportedList.filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(
    pixels.info.width,
    4096,
    'text-only Full quality exports use the existing 4K minimum',
  );
  const exportScale = pixels.info.width / (legacyList.width + 4);
  assert.equal(pixels.info.height, Math.floor((legacyList.height + 4) * exportScale));
  // The original row bands must contain real exported text ink. Width-only
  // scaling moved the first row too low and omitted the second row entirely.
  for (const top of [62, 106]) {
    let ink = 0;
    for (let y = Math.ceil((top + 2) * exportScale); y < (top + 24) * exportScale; y++)
      for (let x = Math.ceil(53 * exportScale); x < 592 * exportScale; x++) {
        const index = (y * pixels.info.width + x) * pixels.info.channels;
        if (
          pixels.data[index] < 110 &&
          pixels.data[index + 1] < 110 &&
          pixels.data[index + 2] < 110
        )
          ink++;
      }
    assert.ok(ink > 150, `legacy row at y=${top} remains present in actual PNG export`);
  }
  await click('[aria-label="Dismiss export notification"]');
  await noError();
  checkpoint('legacy wide list keeps both visible DOM rows and both exported PNG text rows');

  await openBoard(listFixture);
  await until(() => rect('.canvas-list[data-list-id="scaled-list"]'), 'list scale fixture');
  await select(seededList);
  const beforeListMetrics = await listMetrics();
  const listCamera = await settleCamera();
  const listCorner = await point(seededList, seededList.width, seededList.height);
  await drag(listCorner, {
    x: listCorner.x + seededList.width * 0.5 * listCamera.zoom,
    y: listCorner.y + seededList.height * 0.5 * listCamera.zoom,
  });
  const biggerList = (
    await saved(
      (document) => document.objects[0].width > seededList.width * 1.4,
      'list corner resize',
    )
  ).objects[0];
  const afterListMetrics = await listMetrics(),
    listScale = biggerList.width / seededList.width;
  for (const field of ['width', 'checkbox', 'textHeight', 'visibleFont', 'spacing'])
    assert.ok(
      Math.abs(afterListMetrics[field] / beforeListMetrics[field] - listScale) < 0.04,
      `list ${field} scales with its corner resize`,
    );
  assert.ok(
    Math.abs(biggerList.height / seededList.height - listScale) < 0.01,
    'list corner preserves its proportions',
  );
  await key('z', 'KeyZ', 2);
  await saved((document) => document.objects[0].width === seededList.width, 'list resize undo');
  const undoListMetrics = await listMetrics();
  assert.ok(
    Math.abs(undoListMetrics.checkbox - beforeListMetrics.checkbox) < 1,
    'undo restores checkbox size',
  );
  await key('z', 'KeyZ', 10);
  await saved((document) => document.objects[0].width === biggerList.width, 'list resize redo');
  await click('.canvas-list [role="checkbox"][aria-label="First task"]');
  await saved(
    (document) => document.objects[0].items[0].checked,
    'scaled checkbox remains interactive',
  );
  const header = await rect('.canvas-list-header');
  const headerPoint = { x: header.x + header.width / 2, y: header.y + header.height / 2 };
  await clickPoint(headerPoint);
  await clickPoint(headerPoint, 'left', 2);
  await until(
    () => read(`document.querySelector('.canvas-list').dataset.editing==='true'`),
    'scaled list enters edit mode',
  );
  await replaceText('.canvas-list [aria-label="List item 1"]', 'Edited at the larger size');
  await saved(
    (document) => document.objects[0].items[0].text === 'Edited at the larger size',
    'scaled list item edit saved',
  );
  await click('.canvas-list [aria-label="Add list item"]');
  const extendedList = (
    await saved((document) => document.objects[0].items.length === 3, 'scaled list adds a row')
  ).objects[0];
  assert.ok(
    Math.abs(extendedList.height - biggerList.height - 44 * listScale) < 1,
    'added row grows by scaled spacing',
  );
  assert.equal(extendedList.width, biggerList.width, 'editing does not reset the list scale');
  await key('Escape', 'Escape');
  await shot('scaled-list');
  checkpoint(
    'list corner scales text, checkboxes and spacing; editing, adding rows, undo/redo still work',
  );

  await openBoard(fixtures[0]);
  await click('[aria-label="Fit board"]');
  await settleCamera();
  const beforeReload = await state();
  await read('window.__documentReloadMarker=true');
  await renderer.send('Page.reload', { ignoreCache: true });
  await until(
    () =>
      read(
        `!window.__documentReloadMarker && document.querySelector('.board-title')?.textContent===${JSON.stringify(fixtures[0].board.name)}
          && !!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading')`,
      ).catch(() => false),
    'document board reload',
  );
  const afterReload = await state();
  assert.deepEqual(afterReload.objects, beforeReload.objects, 'all document fields survive reload');
  const persisted = await object(original.id);
  await openReader(persisted, 'text');
  assert.equal(
    await read(`document.querySelector('[aria-label="Edit document text"]').value`),
    fixtures[0].expectedText,
  );
  await closeReader();
  await shot('documents-reopened');
  await openBoard(listFixture);
  assert.equal(
    (await state()).objects[0].width,
    biggerList.width,
    'list scale survives board reopening',
  );
  const reopenedListMetrics = await listMetrics();
  assert.ok(
    Math.abs(reopenedListMetrics.checkbox - afterListMetrics.checkbox) < 1,
    'reopened list keeps scaled checkbox size',
  );

  // Portable board round trips must include both originals and generated previews.
  const source = new Store(root),
    roundtrip = new Store(join(root, 'portable-roundtrip'));
  try {
    for (const fixture of fixtures) {
      const originalDocument = source.loadBoard({ id: fixture.board.id });
      const portable = await source.exportBoard({ id: fixture.board.id });
      writeFileSync(join(root, `${fixture.key}.canvasboard`), Buffer.from(portable));
      const imported = await roundtrip.importBoard({ bytes: portable });
      const importedDocument = roundtrip.loadBoard({ id: imported.id });
      assert.deepEqual(
        importedDocument.objects,
        originalDocument.objects,
        `${fixture.key} portable metadata preserved`,
      );
      for (const item of originalDocument.objects) {
        for (const id of [item.assetId, item.documentPreviewId].filter(Boolean)) {
          assert.deepEqual(
            readFileSync(roundtrip.asset({ id, variant: 'original' }).file),
            readFileSync(source.asset({ id, variant: 'original' }).file),
            'portable includes exact original and preview bytes',
          );
        }
      }
    }
  } finally {
    source.close();
    roundtrip.close();
  }
  await noError();
  assert.deepEqual(errors, [], 'no renderer exceptions');
  checkpoint('reload, board reopening, portable originals, and portable previews');
  completed = true;
  console.log('DOCUMENT_DESKTOP_OK', JSON.stringify({ root, executable, steps, errors }));
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
            state: await state(),
            dom: await read('document.body.innerText'),
            inputEvents: await read('window.__documentInputEvents || []'),
            errors,
          },
          null,
          2,
        ),
      );
    } catch {}
  }
  console.error('DOCUMENT_DESKTOP_FAILED', root, error);
  throw error;
} finally {
  writeFileSync(join(root, 'diagnostics.log'), diagnostics);
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify({ completed, steps, errors, executable }, null, 2),
  );
  if (main) {
    try {
      await main.read(
        `(() => {
          const {dialog,ipcMain}=process.mainModule.require('electron');
          const download=globalThis.__documentDownloadTest;if(download)dialog.showSaveDialog=download.original;
          const gate=globalThis.__documentSaveDelay;
          if(gate && !gate.restored){gate.release?.();ipcMain.removeHandler('canvas:invoke');ipcMain.handle('canvas:invoke',gate.original);gate.restored=true;}
        })()`,
      );
    } catch {}
  }
  renderer?.close();
  main?.close();
  // Kill only the packaged child started by this test, never other Terra processes.
  child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
}
