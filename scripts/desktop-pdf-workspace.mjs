// Run after npm run package: node scripts/desktop-pdf-workspace.mjs
// CANVAS_EXECUTABLE can select another packaged build. The real Electron child,
// library, source files, native downloads and screenshots are disposable and local.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename, extname, join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import { inspectPdfPages, pdfWorkspaceFixtures } from '../tests/pdf-workspace-fixtures.mjs';

const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const fixtures = await pdfWorkspaceFixtures();
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-pdf-workspace-'));
mkdirSync(join(root, 'fixtures'));
for (const fixture of Object.values(fixtures)) {
  fixture.path = join(root, 'fixtures', fixture.name);
  writeFileSync(fixture.path, fixture.bytes);
}
const store = new Store(root);
const pdfBoard = store.createBoard({ name: 'PDF workspace check' });
const imageBoard = store.createBoard({ name: 'Image to PDF check' });
const imageViewerBoard = store.createBoard({ name: 'Full resolution image check' });
const imageTiffBoard = store.createBoard({ name: 'TIFF image preview check' });
store.setLastBoard({ id: pdfBoard.id });
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
  completed = false,
  activeBoard = pdfBoard;
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
console.log('PDF_WORKSPACE_STARTED', JSON.stringify({ root, executable, pid: child.pid }));

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
      if (message.method === 'Page.fileChooserOpened') events.push(message);
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
  console.log('PDF_WORKSPACE_CHECK', name);
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
const workspace = '.pdf-workspace[role="dialog"][aria-label="PDF workspace"]';
const command = (label) => `${workspace} [aria-label=${JSON.stringify(label)}]`;
const pageInput = command('PDF page number');
const tiles = () =>
  read(`[...document.querySelectorAll('.pdf-workspace .pdf-page-tile')].map(e=>({
  id:e.dataset.pageId, sourcePage:Number(e.dataset.sourcePage), selected:e.getAttribute('aria-pressed'),
}))`);
async function pageReady() {
  let previous;
  return until(async () => {
    const current = await read(`(() => {
      const page=document.querySelector('.pdf-workspace-page'),c=page?.querySelector('canvas');
      if(!c?.width || !c.height || page.getAttribute('aria-busy')==='true')return null;
      const r=c.getBoundingClientRect();if(r.width<=0 || r.height<=0)return null;
      const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let colored=0;for(let i=0;i<pixels.length;i+=256)
        if(pixels[i+3]>0 && Math.max(pixels[i],pixels[i+1],pixels[i+2])-Math.min(pixels[i],pixels[i+1],pixels[i+2])>35)colored++;
      if(colored<20)return null;
      return {width:r.width,height:r.height,pixelsWidth:c.width,pixelsHeight:c.height,colored};
    })()`);
    const stable =
      current &&
      previous &&
      ['width', 'height', 'pixelsWidth', 'pixelsHeight'].every(
        (key) => Math.abs(current[key] - previous[key]) < 0.5,
      );
    previous = current;
    return stable ? current : null;
  }, 'workspace page painted and settled');
}
async function openWorkspace(object, edit = false) {
  await select(object);
  await click(
    `.selection-tools [aria-label=${JSON.stringify(edit ? 'Edit PDF' : 'Full PDF preview')}]`,
  );
  await until(() => rect(workspace), 'PDF workspace opens');
  await pageReady();
  if (edit) await until(async () => (await tiles()).length > 0, 'page editor sidebar');
}
async function mcpSync(phase) {
  return main.read(`(() => new Promise((resolve,reject) => {
    const {BrowserWindow,ipcMain}=process.mainModule.require('electron');
    const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('canvas-app:'));
    if(!window){reject(Error('Expected test BrowserWindow'));return;}
    // Production transaction IDs are positive counters. Dedicated negative
    // IDs exercise the actual renderer callback without an external mutation.
    const id=-(Date.now()+(globalThis.__pdfWorkspaceMcpSequence=(globalThis.__pdfWorkspaceMcpSequence||0)+1));
    const phase=${JSON.stringify(phase)};
    const cleanup=()=>{clearTimeout(timer);ipcMain.removeListener('canvas:mcp-ready',ready);};
    const ready=(event,message)=>{
      if(event.sender!==window.webContents || message?.id!==id)return;
      cleanup();message.error?reject(Error(message.error)):resolve({id,phase});
    };
    const timer=setTimeout(()=>{cleanup();reject(Error('MCP '+phase+' readiness timed out'));},10000);
    ipcMain.on('canvas:mcp-ready',ready);
    window.webContents.send('canvas:mcp-sync',{id,phase,change:'none'});
  }))()`);
}
async function mcpWhileWorkspaceOpen() {
  await read(`void(window.__pdfWorkspaceBeforeMcp=document.querySelector('.pdf-workspace'))`);
  assert.equal(
    await read(`document.getElementById('root').inert`),
    true,
    'PDF workspace makes the underlying board inert',
  );
  await mcpSync('prepare');
  try {
    assert.equal(
      await read(`document.getElementById('root').inert`),
      true,
      'MCP prepare retains modal inert state',
    );
    assert.equal(
      await read(`document.getElementById('root').dataset.mcpInert`),
      'true',
      'MCP prepare records its independent inert ownership',
    );
    assert.equal(
      await read(`document.querySelector('.pdf-workspace')===window.__pdfWorkspaceBeforeMcp`),
      true,
      'MCP prepare keeps the same PDF workspace open',
    );
  } finally {
    await mcpSync('finish');
  }
  assert.equal(
    await read(`document.getElementById('root').inert`),
    true,
    'MCP finish cannot re-enable the board beneath the PDF workspace',
  );
  assert.equal(
    await read(`document.getElementById('root').hasAttribute('data-mcp-inert')`),
    false,
    'MCP finish releases only its own inert ownership',
  );
  assert.equal(
    await read(`document.querySelector('.pdf-workspace')===window.__pdfWorkspaceBeforeMcp`),
    true,
    'MCP finish keeps the same PDF workspace open',
  );
}
async function closeWorkspace(useEscape = false) {
  if (useEscape) await key('Escape', 'Escape');
  else await click(command('Close PDF workspace'));
  await until(() => read(`!document.querySelector('.pdf-workspace')`), 'PDF workspace closes');
}
async function expectTiles(sourcePages, label) {
  return until(async () => {
    const current = await tiles();
    return current.length === sourcePages.length &&
      current.every((p, i) => p.sourcePage === sourcePages[i])
      ? current
      : null;
  }, label);
}
async function selectTile(index) {
  const current = await tiles();
  assert.ok(current[index], `page tile ${index + 1} exists`);
  const selector = `.pdf-page-tile[data-page-id=${JSON.stringify(current[index].id)}]`;
  // Merging selects a later page and scrolls the sidebar. Bring the actual
  // target into view before dispatching the real pointer click.
  await read(
    `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`,
  );
  await click(selector);
  await until(
    () =>
      read(
        `document.querySelector(${JSON.stringify(pageInput)})?.value===${JSON.stringify(String(index + 1))}`,
      ),
    `page ${index + 1} selected`,
  );
  await pageReady();
}
async function dragTile(fromIndex, toIndex) {
  const current = await tiles();
  const target = `.pdf-page-tile[data-page-id=${JSON.stringify(current[toIndex].id)}]`;
  await read(`document.querySelector(${JSON.stringify(target)}).scrollIntoView({block:'nearest'})`);
  const from = await rect(`.pdf-page-tile[data-page-id=${JSON.stringify(current[fromIndex].id)}]`);
  const to = await rect(target);
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  await mouse('mouseMoved', start, 'left', 1, 0);
  await mouse('mousePressed', start);
  for (let step = 1; step <= 8; step++)
    await mouse('mouseMoved', {
      x: start.x + ((end.x - start.x) * step) / 8,
      y: start.y + ((end.y - start.y) * step) / 8,
    });
  await mouse('mouseReleased', end);
}
async function fileInput(files) {
  const eventCount = renderer.events.length;
  await renderer.send('Page.setInterceptFileChooserDialog', { enabled: true });
  try {
    await click(command('Add PDF or images'));
    const event = await until(
      () =>
        renderer.events
          .slice(eventCount)
          .find((event) => event.method === 'Page.fileChooserOpened'),
      'native file input chooser',
    );
    assert.ok(event.params.backendNodeId, 'file picker is backed by a real input');
    await renderer.send('DOM.setFileInputFiles', {
      files: files.map((fixture) => fixture.path),
      backendNodeId: event.params.backendNodeId,
    });
  } finally {
    await renderer.send('Page.setInterceptFileChooserDialog', { enabled: false });
  }
}
async function convert(label) {
  if (!(await rect(command(label)))) await click(command('Convert PDF'));
  await click(command(label));
}
async function download(action, name) {
  const count = await main.read('globalThis.__pdfWorkspaceDownloads.calls.length');
  await action();
  let previousSize;
  const entry = await until(
    async () => {
      const call = (await main.read('globalThis.__pdfWorkspaceDownloads.calls'))[count];
      if (!call || call.canceled || !existsSync(call.filePath)) return null;
      const size = statSync(call.filePath).size,
        stable = size > 0 && size === previousSize;
      previousSize = size;
      return stable ? call : null;
    },
    `actual native download ${name}`,
    30000,
  );
  assert.equal(basename(entry.defaultPath), name, 'native dialog suggests the required filename');
  assert.equal(basename(entry.filePath), name);
  return { ...entry, bytes: readFileSync(entry.filePath) };
}
async function restoreHooks() {
  if (!main) return;
  await main.read(`(() => {
    const {dialog,ipcMain}=process.mainModule.require('electron');
    const downloads=globalThis.__pdfWorkspaceDownloads;
    if(downloads)dialog.showSaveDialog=downloads.original;
    const gate=globalThis.__pdfWorkspaceImportGate;
    if(gate && !gate.restored){
      gate.release?.();ipcMain.removeHandler('canvas:invoke');
      ipcMain.handle('canvas:invoke',gate.original);gate.restored=true;
    }
  })()`);
}
async function cancelHeldConversion(name) {
  const before = await tiles();
  const calls = await main.read('globalThis.__pdfWorkspaceDownloads.calls.length');
  await main.read(`(() => {
    const {ipcMain}=process.mainModule.require('electron');
    const original=ipcMain._invokeHandlers.get('canvas:invoke');
    if(typeof original!=='function')throw Error('Expected real canvas:invoke handler');
    const gate=globalThis.__pdfWorkspaceImportGate={original,armed:true,started:0,completed:0,released:0,watchdogFired:false,restored:false};
    ipcMain.removeHandler('canvas:invoke');
    ipcMain.handle('canvas:invoke',async(event,command,args)=>{
      if(gate.armed && command==='importAsset' && args?.name===${JSON.stringify(name)}){
        gate.armed=false;gate.started=Date.now();
        await new Promise(resolve=>{
          const watchdog=setTimeout(()=>{gate.watchdogFired=true;gate.release();},10000);
          gate.release=()=>{if(gate.released)return;gate.released=Date.now();clearTimeout(watchdog);resolve();};
        });
        const result=await original(event,command,args);gate.completed=Date.now();return result;
      }
      return original(event,command,args);
    });return true;
  })()`);
  try {
    await convert('Download text');
    await until(
      () => main.read('globalThis.__pdfWorkspaceImportGate.started>0'),
      'output import held before native download',
    );
    await click(command('Cancel PDF operation'));
    assert.equal(await main.read('globalThis.__pdfWorkspaceDownloads.calls.length'), calls);
    await main.read('globalThis.__pdfWorkspaceImportGate.release()');
    await until(
      () => main.read('globalThis.__pdfWorkspaceImportGate.completed>0'),
      'canceled output import finishes',
    );
    await until(
      () => read(`!document.querySelector(${JSON.stringify(command('Cancel PDF operation'))})`),
      'canceled conversion settles',
    );
    await sleep(250);
    assert.equal(
      await main.read('globalThis.__pdfWorkspaceDownloads.calls.length'),
      calls,
      'cancel during importAsset cannot open a native download dialog afterward',
    );
    assert.deepEqual(await tiles(), before, 'conversion cancellation preserves the edited pages');
    assert.equal(
      await main.read('globalThis.__pdfWorkspaceImportGate.watchdogFired'),
      false,
      'test releases the held import explicitly',
    );
  } finally {
    await main.read(`(() => {
      const {ipcMain}=process.mainModule.require('electron'),gate=globalThis.__pdfWorkspaceImportGate;
      gate.release?.();ipcMain.removeHandler('canvas:invoke');ipcMain.handle('canvas:invoke',gate.original);gate.restored=true;
    })()`);
  }
}
async function pdfPagesMatch(bytes, expected) {
  const pages = await inspectPdfPages(bytes);
  assert.deepEqual(
    pages,
    expected,
    'PDF page content, order, dimensions and rotation match the edited workspace',
  );
}
async function imageZip(bytes, format, expected) {
  const entries = Object.entries(unzipSync(bytes))
    .filter(([name]) => !name.endsWith('/'))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  assert.equal(entries.length, expected.length, 'ZIP includes exactly one image per edited page');
  for (const [index, [name, bytes]] of entries.entries()) {
    assert.ok(
      format === 'png' ? /\.png$/i.test(name) : /\.jpe?g$/i.test(name),
      `correct image extension: ${name}`,
    );
    const meta = await sharp(bytes).metadata();
    assert.equal(meta.format, format);
    const page = expected[index],
      rotated = page.rotation === 90 || page.rotation === 270;
    const ratio = rotated ? page.height / page.width : page.width / page.height;
    assert.ok(
      Math.abs(meta.width / meta.height - ratio) < 0.015,
      `exported page ${index + 1} preserves order and rotation (${meta.width}x${meta.height})`,
    );
    assert.ok(meta.width >= 180 && meta.height >= 180, 'export contains readable page images');
    const colors = [
      fixtures.source.pages[1].color.map((value) => Math.round(value * 255)),
      fixtures.source.pages[0].color.map((value) => Math.round(value * 255)),
      ...fixtures.merge.pages.map((page) => page.color.map((value) => Math.round(value * 255))),
      [235, 137, 43],
      [135, 64, 202],
    ];
    const pixels = await sharp(bytes).resize(64, 64).removeAlpha().raw().toBuffer();
    let matching = 0;
    for (let offset = 0; offset < pixels.length; offset += 3)
      if (colors[index].every((value, channel) => Math.abs(pixels[offset + channel] - value) < 35))
        matching++;
    assert.ok(matching > 100, `exported page ${index + 1} contains its original colored content`);
  }
}
async function assertOriginal(object) {
  const current = (await state(pdfBoard)).objects.find((item) => item.id === object.id);
  assert.ok(current, 'original document remains on the board');
  for (const field of ['assetId', 'text', 'x', 'y', 'width', 'height'])
    assert.equal(current[field], object[field], `original ${field} remains unchanged`);
  assert.equal(hash(originalAsset(object.assetId)), hash(fixtures.source.bytes));
}

const imageViewer = '.image-viewer[role="dialog"][aria-label="Image preview"]';
const imageCommand = (label) => `${imageViewer} [aria-label=${JSON.stringify(label)}]`;
const imageMetrics = () =>
  read(`(() => {
  const root=document.querySelector('.image-viewer'),img=root?.querySelector('img'),stage=root?.querySelector('.image-viewer-stage');
  if(!root || !img || !stage)return null;
  const r=img.getBoundingClientRect(),s=stage.getBoundingClientRect();
  return {state:root.dataset.state,id:root.dataset.imageId,src:img.currentSrc || img.src,
    complete:img.complete,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,
    x:r.x,y:r.y,width:r.width,height:r.height,
    stage:{x:s.x,y:s.y,width:s.width,height:s.height},zoom:Number(stage.dataset.zoom)};
})()`);
async function imageReady(object, fixture) {
  return until(async () => {
    const current = await imageMetrics();
    return current?.id === object.id &&
      current.state === 'ready' &&
      current.complete &&
      current.naturalWidth === fixture.width &&
      current.naturalHeight === fixture.height &&
      current.width > 0 &&
      current.height > 0
      ? current
      : null;
  }, `${fixture.name} full resolution image loads`);
}
async function doubleClickImage(object, fixture) {
  const body = await point(object, object.width / 2, object.height / 2);
  // Theme view-transition snapshots temporarily receive pointer input on HTML.
  // Wait for the actual canvas to be hittable before the native double click.
  await until(
    () =>
      read(`(() => {
    const target=document.elementFromPoint(${body.x},${body.y});
    return target?.tagName==='CANVAS' && target.getAttribute('aria-label')==='Infinite whiteboard';
  })()`),
    'image body accepts native pointer input',
  );
  await read(`void(window.__imageTestPoint=(()=>{
    const point=${JSON.stringify(body)},target=document.elementFromPoint(point.x,point.y);
    return {point,target:target?.tagName,className:target?.className,
      titleEditor:!!document.querySelector('textarea[aria-label="Edit image title"]')};
  })())`);
  await clickPoint(body);
  await clickPoint(body, 'left', 2);
  await until(() => rect(imageViewer), 'native body double-click opens image preview');
  assert.equal(
    await read(`!!document.querySelector('textarea[aria-label="Edit image title"]')`),
    false,
    'titled image body opens the viewer instead of its title editor',
  );
  return imageReady(object, fixture);
}
async function imageFits() {
  return until(async () => {
    const value = await imageMetrics();
    if (!value || value.state !== 'ready') return null;
    const stage = value.stage;
    return value.x >= stage.x - 1 &&
      value.y >= stage.y - 1 &&
      value.x + value.width <= stage.x + stage.width + 1 &&
      value.y + value.height <= stage.y + stage.height + 1
      ? value
      : null;
  }, 'fitted image stays inside its viewport');
}
async function verifyFullImage(object, fixture) {
  const rendered = await imageReady(object, fixture);
  assert.equal(
    rendered.src,
    `canvas-media://asset/${object.assetId}/export`,
    'viewer loads the full export endpoint',
  );
  const expectedPixels = await sharp(fixture.bytes).rotate().ensureAlpha().raw().toBuffer();
  const response = await read(`(async()=>{
    const img=document.querySelector('.image-viewer img');
    const response=await fetch(img.currentSrc || img.src),blob=await response.blob();
    const bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');
    try {
      canvas.width=bitmap.width;canvas.height=bitmap.height;
      const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
      const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
      const digest=await crypto.subtle.digest('SHA-256',pixels);
      return {width:bitmap.width,height:bitmap.height,mime:blob.type,
        hash:[...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('')};
    } finally {bitmap.close();canvas.width=canvas.height=1;}
  })()`);
  assert.deepEqual(
    { width: response.width, height: response.height },
    { width: fixture.width, height: fixture.height },
  );
  assert.equal(response.mime, 'image/png', 'export is the lossless orientation-correct fallback');
  assert.equal(
    response.hash,
    hash(expectedPixels),
    'full-resolution decoded RGBA exactly matches the source',
  );
}
async function assertImageUnchanged(object, fixture) {
  const current = (await state()).objects.find((item) => item.id === object.id);
  assert.deepEqual(
    current,
    object,
    'image preview, panning and download preserve title and board geometry',
  );
  assert.deepEqual(
    originalAsset(object.assetId),
    fixture.bytes,
    'image source bytes stay unchanged',
  );
}
async function imageContextTitle(object) {
  await clickPoint(await point(object, object.width / 2, object.height / 2), 'right');
  const target = await until(
    () =>
      read(`(() => {
    const item=[...document.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent.trim()==='Edit title');
    if(!item)return null;const r=item.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`),
    'image context Edit title action',
  );
  await clickPoint(target);
  await until(() => rect('textarea[aria-label="Edit image title"]'), 'context title editor opens');
  assert.equal(
    await read(`document.querySelector('textarea[aria-label="Edit image title"]').value`),
    object.imageTitle,
  );
  await key('Escape', 'Escape');
}
async function checkImageViewer() {
  await openBoard(imageViewerBoard);
  await read(`(() => {
    window.__imageInputEvents=[];
    for(const type of ['pointerdown','pointerup','mousedown','mouseup','click','dblclick'])
      document.addEventListener(type,event=>{
        window.__imageInputEvents.push({type,detail:event.detail,x:event.clientX,y:event.clientY,
          tag:event.target.tagName,className:typeof event.target.className==='string'?event.target.className:'',
          titleEditor:!!document.querySelector('textarea[aria-label="Edit image title"]'),viewer:!!document.querySelector('.image-viewer')});
        if(window.__imageInputEvents.length>120)window.__imageInputEvents.shift();
      },true);
  })()`);
  const imported = await importOnBoard(fixtures.viewerPng, 'image');
  await select(imported);
  assert.equal(
    await read(`!!document.querySelector('.image-viewer')`),
    false,
    'single click selects an image without opening its viewer',
  );
  await click('.selection-tools [aria-label="Add title"]');
  const editor = 'textarea[aria-label="Edit image title"]';
  await until(() => rect(editor), 'T title control opens image title editor');
  await replaceText(editor, 'Original pixels — separate image title');
  const titled = (
    await saved(
      (doc) =>
        doc.objects.some(
          (object) =>
            object.id === imported.id &&
            object.imageTitle === 'Original pixels — separate image title',
        ),
      'image title persists',
    )
  ).objects.find((object) => object.id === imported.id);
  await select(titled);
  await renderer.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await until(
    () =>
      read(
        `document.documentElement.dataset.theme==='light' && !document.documentElement.matches(':active-view-transition')`,
      ),
    'light image preview appearance',
  );
  await doubleClickImage(titled, fixtures.viewerPng);
  await verifyFullImage(titled, fixtures.viewerPng);
  await imageFits();
  assert.equal(await read(`document.getElementById('root').inert`), true);

  await click(imageCommand('Actual image size'));
  const actual = await until(async () => {
    const value = await imageMetrics();
    return value && Math.abs(value.width - fixtures.viewerPng.width) < 1 ? value : null;
  }, 'actual image size uses one CSS pixel per source pixel');
  assert.ok(Math.abs(actual.height - fixtures.viewerPng.height) < 1);
  const start = {
    x: actual.stage.x + actual.stage.width / 2,
    y: actual.stage.y + actual.stage.height / 2,
  };
  const end = { x: start.x + 120, y: start.y + 70 };
  await mouse('mouseMoved', start, 'left', 1, 0);
  await mouse('mousePressed', start);
  for (let step = 1; step <= 8; step++)
    await mouse('mouseMoved', {
      x: start.x + ((end.x - start.x) * step) / 8,
      y: start.y + ((end.y - start.y) * step) / 8,
    });
  await mouse('mouseReleased', end);
  const panned = await until(async () => {
    const value = await imageMetrics();
    return value && Math.abs(value.x - actual.x) > 60 && Math.abs(value.y - actual.y) > 30
      ? value
      : null;
  }, 'native pointer drag pans the full-size image');
  assert.equal(panned.width, actual.width, 'panning does not resample the image');
  await click(imageCommand('Zoom image out'));
  const smaller = await until(async () => {
    const value = await imageMetrics();
    return value && value.width < actual.width * 0.95 ? value : null;
  }, 'image zoom out');
  await click(imageCommand('Zoom image in'));
  await until(async () => (await imageMetrics())?.width > smaller.width * 1.05, 'image zoom in');
  await click(imageCommand('Fit image'));
  await imageFits();
  await renderer.send('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await until(async () => (await imageMetrics())?.stage.width < 1100, 'image viewport resizes');
  await imageFits();
  await renderer.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await until(async () => (await imageMetrics())?.stage.width > 1300, 'image viewport restores');
  await imageFits();
  await shot('full-image-light');
  const originalDownload = await download(
    () => click(imageCommand('Download image')),
    fixtures.viewerPng.name,
  );
  assert.deepEqual(
    originalDownload.bytes,
    fixtures.viewerPng.bytes,
    'image download retains original encoded bytes and filename',
  );

  // Modal protection must not depend on focus remaining inside the portal.
  const ids = (await state()).objects.map((object) => object.id).sort();
  await read('document.activeElement?.blur()');
  assert.equal(await read('document.activeElement===document.body'), true);
  await key('Delete', 'Delete');
  await key('Backspace', 'Backspace');
  await key('k', 'KeyK', 2);
  await key('f', 'KeyF', 2);
  await sleep(500);
  assert.equal(
    await read(`!!document.querySelector('.modal-backdrop')`),
    false,
    'image modal blocks board search shortcuts after focus loss',
  );
  assert.deepEqual(
    (await state()).objects.map((object) => object.id).sort(),
    ids,
    'image modal blocks board deletion after focus loss',
  );
  await assertImageUnchanged(titled, fixtures.viewerPng);
  await click(imageCommand('Fit image'));
  await renderer.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await until(
    () =>
      read(
        `document.documentElement.dataset.theme==='dark' && !document.documentElement.matches(':active-view-transition')`,
      ),
    'dark image preview appearance',
  );
  await shot('full-image-dark');
  await key('Escape', 'Escape');
  await until(
    () =>
      read(`!document.querySelector('.image-viewer') && !document.getElementById('root').inert`),
    'Escape closes image preview and restores board input',
  );
  await until(
    () => rect('.selection-tools [aria-label="Edit title"]'),
    'image selection remains after preview closes',
  );
  await click('.selection-tools [aria-label="Edit title"]');
  await until(() => rect(editor), 'T control still edits the image title');
  assert.equal(
    await read(`document.querySelector(${JSON.stringify(editor)}).value`),
    titled.imageTitle,
  );
  const titleRect = await rect(editor);
  const titlePoint = {
    x: titleRect.x + Math.min(24, titleRect.width / 2),
    y: titleRect.y + Math.min(12, titleRect.height / 2),
  };
  await key('Escape', 'Escape');
  await imageContextTitle(titled);
  await until(
    () =>
      read(`!document.querySelector(${JSON.stringify(editor)}) &&
        document.elementFromPoint(${titlePoint.x},${titlePoint.y})?.getAttribute('aria-label')==='Infinite whiteboard'`),
    'existing image title accepts native pointer input',
  );
  await clickPoint(titlePoint);
  await until(() => rect(editor), 'single click on existing image title opens its editor');
  assert.equal(
    await read(`document.querySelector(${JSON.stringify(editor)}).value`),
    titled.imageTitle,
  );
  assert.equal(
    await read(`!!document.querySelector('.image-viewer')`),
    false,
    'single title click edits the title without opening the image viewer',
  );
  await key('Escape', 'Escape');
  await assertImageUnchanged(titled, fixtures.viewerPng);

  // A decode error is injected only into the test DOM. The stored original is
  // untouched, so the fallback must still offer its exact downloadable bytes.
  await doubleClickImage(titled, fixtures.viewerPng);
  await read(`void(document.querySelector('.image-viewer img').src='data:image/png;base64,AA==')`);
  await until(
    () =>
      read(`document.querySelector('.image-viewer')?.dataset.state==='error'
    && !!document.querySelector('.image-viewer-load-error[role="alert"]')`),
    'image decode failure shows a bounded fallback',
  );
  const fallbackDownload = await download(
    () => click(imageCommand('Download image')),
    fixtures.viewerPng.name,
  );
  assert.deepEqual(
    fallbackDownload.bytes,
    fixtures.viewerPng.bytes,
    'image preview failure keeps the original download available',
  );
  await shot('image-preview-error');
  await key('Escape', 'Escape');
  await until(
    () => read(`!document.querySelector('.image-viewer')`),
    'failed image preview closes',
  );
  await assertImageUnchanged(titled, fixtures.viewerPng);
  checkpoint(
    'titled image double-click and direct title editing, full PNG pixels, actual size, zoom, pointer pan, resize, exact download and modal isolation',
  );

  await openBoard(imageTiffBoard);
  const tiff = await importOnBoard(fixtures.viewerTiff, 'image');
  await select(tiff);
  await doubleClickImage(tiff, fixtures.viewerTiff);
  await verifyFullImage(tiff, fixtures.viewerTiff);
  await imageFits();
  const tiffDownload = await download(
    () => click(imageCommand('Download image')),
    fixtures.viewerTiff.name,
  );
  assert.deepEqual(
    tiffDownload.bytes,
    fixtures.viewerTiff.bytes,
    'TIFF preview fallback downloads the original TIFF bytes',
  );
  await shot('full-image-tiff-fallback');
  await click(imageCommand('Close image preview'));
  await until(
    () =>
      read(`!document.querySelector('.image-viewer') && !document.getElementById('root').inert`),
    'Close control exits TIFF preview',
  );
  await assertImageUnchanged(tiff, fixtures.viewerTiff);
  assert.deepEqual(errors, [], 'image viewing produces no uncaught renderer exceptions');
  checkpoint(
    'full-resolution lossless TIFF preview and original download; image error fallback stays downloadable',
  );
}

try {
  const mainTarget = await targetAt(inspectorPort, (target) => !!target.webSocketDebuggerUrl);
  main = await connect(mainTarget.webSocketDebuggerUrl);
  await main.send('Runtime.enable');
  await until(
    () => main.read(`typeof process.mainModule?.require==='function'`).catch(() => false),
    'packaged main initialized',
  );
  assert.equal(await main.read(`process.mainModule.require('electron').app.isPackaged`), true);
  // Only the isolated child has its native chooser patched. Product IPC writes
  // every file normally, so these checks exercise actual downloadable bytes.
  await main.read(`(() => {
    const {dialog}=process.mainModule.require('electron');
    const fs=process.mainModule.require('node:fs'),path=process.mainModule.require('node:path');
    const state=globalThis.__pdfWorkspaceDownloads={calls:[],cancelNext:false,original:dialog.showSaveDialog};
    dialog.showSaveDialog=async(...args)=>{
      const options=args.at(-1),canceled=state.cancelNext;state.cancelNext=false;
      const folder=path.join(process.env.CANVAS_DATA_DIR,'downloads',String(state.calls.length+1));
      fs.mkdirSync(folder,{recursive:true});
      const filePath=path.join(folder,path.basename(options.defaultPath));
      state.calls.push({defaultPath:options.defaultPath,filePath,canceled});
      return canceled?{canceled:true}:{canceled:false,filePath};
    }; return true;
  })()`);
  const target = await targetAt(
    rendererPort,
    (target) => target.type === 'page' && target.url.startsWith('canvas-app:'),
  );
  renderer = await connect(target.webSocketDebuggerUrl, true);
  await renderer.send('Runtime.enable');
  await renderer.send('Page.enable');
  await renderer.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await renderer.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await boardReady();
  // The disposable profile defaults to System. Reloading before the initial
  // loadURL finishes aborts Electron startup; emulate the OS and wait instead.
  await until(
    () => read(`document.documentElement.dataset.theme==='light'`),
    'fresh light workspace',
  );
  assert.equal(
    resolve(await read('window.canvas.dataDirectory()')),
    root,
    'no real Library access',
  );
  checkpoint('packaged app ready in disposable library');
  const original = await importOnBoard(fixtures.source, 'document');
  await saved(
    (doc) => !!doc.objects.find((o) => o.id === original.id)?.documentPreviewId,
    'original PDF card preview',
  );

  await openWorkspace(original);
  await mcpWhileWorkspaceOpen();
  const full = await rect(workspace),
    viewport = await read('({width:innerWidth,height:innerHeight})');
  assert.ok(
    full.width > viewport.width * 0.9 && full.height > viewport.height * 0.9,
    'PDF uses the full app workspace',
  );
  const fitted = await pageReady();
  assert.ok(
    fitted.width > 400 && fitted.height > 450,
    'full preview is substantially larger than the document card',
  );
  assert.equal(await read(`document.querySelector(${JSON.stringify(pageInput)}).value`), '1');
  await click(command('Edit PDF pages'));
  await expectTiles([1, 2], 'preview toggles into page editing');
  await click(command('Edit PDF pages'));
  await until(
    () => read(`!document.querySelector('.pdf-page-tile')`),
    'edit toggle restores full preview',
  );
  await pageReady();
  await click(command('Next PDF page'));
  await until(
    () => read(`document.querySelector(${JSON.stringify(pageInput)}).value==='2'`),
    'next PDF page',
  );
  await pageReady();
  await click(command('Previous PDF page'));
  await until(
    () => read(`document.querySelector(${JSON.stringify(pageInput)}).value==='1'`),
    'previous PDF page',
  );
  await replaceText(pageInput, '2');
  await until(
    () => read(`document.querySelector(${JSON.stringify(pageInput)}).value==='2'`),
    'keyboard page number',
  );
  const beforeZoom = await pageReady();
  await click(command('Zoom PDF in'));
  await until(
    async () => (await rect('.pdf-workspace-page canvas'))?.width > beforeZoom.width * 1.05,
    'PDF zooms in',
  );
  await pageReady();
  await click(command('Zoom PDF out'));
  await pageReady();
  await click(command('Fit PDF width'));
  const wide = await pageReady();
  await click(command('Fit PDF page'));
  const fit = await pageReady();
  assert.ok(wide.width > fit.width * 1.1, 'fit width and fit page use distinct real canvas sizes');
  await shot('full-preview-light');
  await closeWorkspace(true);
  await until(
    () => read(`!document.getElementById('root').inert`),
    'closing PDF workspace restores board input after MCP prepare/finish',
  );
  await assertOriginal(original);
  checkpoint(
    'ribbon full preview, MCP prepare/finish preserves modal inert state, native navigation, zoom and fit',
  );

  // Both on-board and ribbon entry points lead to the same full workspace.
  await select(original);
  await click('.selection-tools [aria-label="Preview document"]');
  await until(() => rect('.document-reader canvas'), 'inline PDF reader');
  assert.ok(
    await rect('.document-reader [aria-label="Edit PDF"]'),
    'inline reader offers page editing',
  );
  await click('.document-reader [aria-label="Full PDF preview"]');
  await until(() => rect(workspace), 'inline reader opens full PDF workspace');
  await pageReady();
  await closeWorkspace();
  if (!(await rect('.document-reader'))) {
    await select(original);
    await click('.selection-tools [aria-label="Preview document"]');
    await until(() => rect('.document-reader canvas'), 'inline reader reopens');
  }
  await click('.document-reader [aria-label="Edit PDF"]');
  await until(() => rect(`${workspace}[data-mode="edit"]`), 'inline reader opens PDF edit mode');
  await expectTiles([1, 2], 'inline edit entry point loads source pages');
  await pageReady();
  await closeWorkspace();
  if (await rect('.document-reader')) await click('.document-reader [aria-label="Close document"]');

  await openWorkspace(original, true);
  let current = await expectTiles([1, 2], 'two original page tiles');
  const [firstId, secondId] = current.map((page) => page.id);
  assert.ok(
    firstId && secondId && firstId !== secondId,
    'page tiles have stable unique identities',
  );
  await selectTile(1);
  await click(command('Move page earlier'));
  current = await expectTiles([2, 1], 'page two moved earlier');
  assert.deepEqual(
    current.map((page) => page.id),
    [secondId, firstId],
  );
  await click(command('Move page later'));
  await expectTiles([1, 2], 'page two moved later');
  await click(command('Move page earlier'));
  await expectTiles([2, 1], 'page two moved back to first');
  await dragTile(0, 1);
  await expectTiles([1, 2], 'native pointer drag moves first tile after second');
  await dragTile(1, 0);
  await expectTiles([2, 1], 'native pointer drag moves second tile back before first');
  await selectTile(0);
  await click(command('Rotate page'));
  await until(async () => {
    const page = await rect('.pdf-workspace-page canvas');
    return page && page.width > page.height;
  }, 'rotated page visibly becomes landscape');
  await pageReady();
  await click(command('Duplicate page'));
  const duplicated = await expectTiles([2, 2, 1], 'selected page duplicated');
  assert.equal(
    new Set(duplicated.map((page) => page.id)).size,
    3,
    'duplicated page has its own identity',
  );
  await selectTile(1);
  await click(command('Remove page'));
  await expectTiles([2, 1], 'duplicate removed');
  await click(command('Undo PDF edit'));
  await expectTiles([2, 2, 1], 'PDF undo restores removed page');
  await click(command('Redo PDF edit'));
  await expectTiles([2, 1], 'PDF redo removes restored page');
  checkpoint(
    'inline entry point, button and native pointer reorder, rotate, duplicate, remove and undo/redo',
  );

  await nativeDrop([fixtures.merge, fixtures.png, fixtures.jpg], '.pdf-workspace-page');
  await expectTiles([2, 1, 1, 2, 1, 1], 'dropped PDF and images append in file order');
  const beforeMalformed = await tiles();
  await fileInput([fixtures.png, fixtures.malformed]);
  await until(
    () => read(`!!document.querySelector('.pdf-workspace [role="alert"]')?.textContent.trim()`),
    'malformed import reports an error',
    15000,
  );
  assert.deepEqual(
    await tiles(),
    beforeMalformed,
    'malformed batch import is atomic, including earlier valid files',
  );
  await click(command('Dismiss PDF error'));
  await until(
    () => read(`!document.querySelector('.pdf-workspace [role="alert"]')`),
    'import error can be dismissed',
  );
  assert.equal(
    (await state()).objects.length,
    1,
    'workspace file drops do not leak attachments onto the board',
  );
  await selectTile(0);
  await renderer.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await until(
    () =>
      read(
        `document.documentElement.dataset.theme==='dark' && !document.documentElement.matches(':active-view-transition')`,
      ),
    'dark appearance',
  );
  await shot('edited-pages-dark');
  checkpoint(
    'native PDF/PNG/JPG merge, intercepted real file input, atomic malformed batch, dark screenshot',
  );

  const expected = [
    { width: 640, height: 820, rotation: 90, marker: fixtures.source.pages[1].marker },
    { width: 600, height: 800, rotation: 0, marker: fixtures.source.pages[0].marker },
    ...fixtures.merge.pages.map(({ width, height, marker }) => ({
      width,
      height,
      rotation: 0,
      marker,
    })),
    { width: 240, height: 180, rotation: 0, marker: null },
    { width: 180, height: 240, rotation: 0, marker: null },
  ];
  const base = basename(fixtures.source.name, '.pdf');
  const cancelCount = await main.read('globalThis.__pdfWorkspaceDownloads.calls.length');
  await main.read('globalThis.__pdfWorkspaceDownloads.cancelNext=true');
  await convert('Download text');
  const canceled = await until(
    async () => (await main.read('globalThis.__pdfWorkspaceDownloads.calls'))[cancelCount],
    'native save dialog cancellation',
  );
  assert.equal(canceled.canceled, true);
  assert.equal(existsSync(canceled.filePath), false, 'canceling download writes no file');
  assert.ok(await rect(workspace), 'canceling conversion leaves the PDF workspace open');
  assert.equal((await tiles()).length, expected.length);
  const textDownload = await download(() => convert('Download text'), `${base}.txt`);
  const text = textDownload.bytes.toString('utf8'),
    markers = expected.map((page) => page.marker).filter(Boolean);
  let previous = -1;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    assert.ok(index > previous, `TXT follows edited PDF order: ${marker}`);
    assert.equal(
      text.indexOf(marker, index + marker.length),
      -1,
      'removed duplicate is absent from text export',
    );
    previous = index;
  }
  const png = await download(() => convert('Download PNG pages'), `${base}-pages.zip`);
  await imageZip(png.bytes, 'png', expected);
  const jpg = await download(() => convert('Download JPG pages'), `${base}-pages.zip`);
  await imageZip(jpg.bytes, 'jpeg', expected);
  const extracted = await download(() => convert('Extract current page'), `${base}-page-1.pdf`);
  await pdfPagesMatch(extracted.bytes, [expected[0]]);
  await cancelHeldConversion(`${base}.txt`);
  await assertOriginal(original);
  checkpoint(
    'real TXT/PNG/JPG/extracted-PDF downloads match edited order and rotation; dialog and pending-import cancellation verified',
  );

  await click(command('Save PDF copy'));
  const savedBoard = await saved(
    (doc) => doc.objects.some((o) => o.type === 'document' && o.text === `${base}-edited.pdf`),
    'edited PDF copy added to board',
  );
  await until(
    () => read(`!document.querySelector('.pdf-workspace')`),
    'successful save closes PDF workspace',
  );
  const edited = savedBoard.objects.find(
    (o) => o.type === 'document' && o.text === `${base}-edited.pdf`,
  );
  assert.equal(savedBoard.objects.length, 2, 'save adds one sibling document');
  assert.notEqual(edited.id, original.id);
  assert.notEqual(edited.assetId, original.assetId);
  await pdfPagesMatch(originalAsset(edited.assetId), expected);
  await assertOriginal(original);
  await saved(
    (doc) => !!doc.objects.find((o) => o.id === edited.id)?.documentPreviewId,
    'saved PDF gets a real card preview',
  );
  await shot('saved-copy-board');

  // The close prompt keeps a draft when canceled, then discards it explicitly.
  await openWorkspace(original, true);
  await expectTiles([1, 2], 'source reopens with its untouched two pages');
  await click(command('Rotate page'));
  await pageReady();
  await key('Escape', 'Escape');
  const prompt = '.pdf-workspace [role="alertdialog"][aria-label="Unsaved PDF changes"]';
  await until(() => rect(prompt), 'unsaved draft asks whether to keep or discard');
  await click(`${prompt} button:first-child`);
  await until(
    () => read(`!document.querySelector(${JSON.stringify(prompt)})`),
    'Keep editing retains the draft',
  );
  assert.ok(await rect(workspace));
  const draft = await pageReady();
  assert.ok(draft.width > draft.height, 'canceling close preserves the rotated draft');
  assert.equal(
    await read(`!!document.activeElement?.closest('.pdf-workspace')`),
    true,
    'Keep editing restores focus inside the workspace',
  );
  // Reproduce focus loss from removing a focused prompt control. App-level key
  // handlers must still respect the modal when the event target is the body.
  const boardIds = (await state()).objects.map((object) => object.id).sort();
  await read('document.activeElement?.blur()');
  assert.equal(await read('document.activeElement===document.body'), true);
  await key('Delete', 'Delete');
  await key('Backspace', 'Backspace');
  await key('k', 'KeyK', 2);
  await key('f', 'KeyF', 2);
  await sleep(500);
  assert.equal(
    await read(`!!document.querySelector('.modal-backdrop')`),
    false,
    'PDF workspace blocks board search shortcuts even after focus loss',
  );
  assert.deepEqual(
    (await state()).objects.map((object) => object.id).sort(),
    boardIds,
    'Delete and Backspace in PDF workspace do not delete board source objects',
  );
  await click(command('Close PDF workspace'));
  await until(() => rect(prompt), 'close control reopens unsaved prompt');
  await key('Escape', 'Escape');
  await until(
    () => read(`!document.querySelector(${JSON.stringify(prompt)})`),
    'Escape dismisses close prompt without discarding',
  );
  assert.equal(
    await read(`!!document.activeElement?.closest('.pdf-workspace')`),
    true,
    'Escape restores focus to the PDF workspace',
  );
  await click(command('Close PDF workspace'));
  await until(() => rect(prompt), 'explicit discard prompt');
  await click(command('Discard PDF changes'));
  await until(
    () => read(`!document.querySelector('.pdf-workspace')`),
    'explicit discard closes draft',
  );
  assert.equal((await state()).objects.length, 2, 'closing an unsaved draft adds no document');
  await assertOriginal(original);
  await read('window.__pdfWorkspaceReloadMarker=true');
  await renderer.send('Page.reload');
  await until(
    () =>
      read(
        '!window.__pdfWorkspaceReloadMarker && !!document.querySelector(".canvas-surface canvas") && !document.querySelector(".canvas-loading")',
      ).catch(() => false),
    'board reload after PDF copy',
  );
  await boardReady();
  const reloaded = await state();
  assert.ok(reloaded.objects.some((o) => o.id === edited.id && o.assetId === edited.assetId));
  await pdfPagesMatch(originalAsset(edited.assetId), expected);
  await assertOriginal(original);
  checkpoint(
    'saved sibling PDF preserves vector content, order and rotations; original bytes, cancel and reload verified',
  );

  await openBoard(imageBoard);
  const sourceImage = await importOnBoard(fixtures.png, 'image');
  await select(sourceImage);
  await clickPoint(await point(sourceImage), 'right');
  const item = await until(
    () =>
      read(`(() => {
    const e=[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.trim()==='Convert to PDF');
    if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`),
    'image Convert to PDF context command',
  );
  await clickPoint(item);
  await until(() => rect(workspace), 'image opens PDF editing workspace');
  await pageReady();
  await expectTiles([1], 'one image page');
  await click(command('Save PDF copy'));
  const imagePdfName = basename(fixtures.png.name, extname(fixtures.png.name)) + '.pdf';
  const imageState = await saved(
    (doc) => doc.objects.some((o) => o.type === 'document' && o.text === imagePdfName),
    'image-only PDF added to board',
  );
  await until(
    () => read(`!document.querySelector('.pdf-workspace')`),
    'image PDF save closes workspace',
  );
  const imagePdf = imageState.objects.find((o) => o.type === 'document' && o.text === imagePdfName);
  await pdfPagesMatch(originalAsset(imagePdf.assetId), [
    { width: 240, height: 180, rotation: 0, marker: null },
  ]);
  assert.equal(imageState.objects.length, 2);
  assert.equal(
    imageState.objects.find((o) => o.id === sourceImage.id).assetId,
    sourceImage.assetId,
  );
  assert.deepEqual(originalAsset(sourceImage.assetId), fixtures.png.bytes);
  await shot('image-to-pdf-board');
  assert.deepEqual(errors, [], 'no uncaught renderer exceptions');
  checkpoint('image context conversion produces a real PDF and preserves its source image');

  await checkImageViewer();
  await openBoard(imageBoard);

  // Exercise the native window close event, its renderer flush callback and
  // persisted output. Closing this isolated child never touches another app.
  await openWorkspace(imagePdf, true);
  await click(command('Rotate page'));
  await pageReady();
  await shot('unsaved-draft-before-native-close');
  await restoreHooks();
  const nativeExit = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  await main.read(`(() => {
    const {BrowserWindow}=process.mainModule.require('electron');
    const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('canvas-app:'));
    if(!window)throw Error('Expected test BrowserWindow');window.close();return true;
  })()`);
  // Detach the debugger so it cannot keep a correctly closing process alive.
  renderer.close();
  main.close();
  renderer = undefined;
  main = undefined;
  const exit = await Promise.race([nativeExit, sleep(20000).then(() => null)]);
  assert.ok(exit, 'native window close finishes after flushing the PDF draft');
  assert.equal(exit.code, 0, 'test app exits normally after native close');
  const persistedStore = new Store(root);
  try {
    const closedBoard = persistedStore.loadBoard({ id: imageBoard.id });
    const autosaved = closedBoard.objects.find(
      (object) => object.text === 'Landscape image-edited.pdf',
    );
    assert.ok(autosaved, 'native close saves a dirty PDF workspace as a sibling copy');
    assert.equal(closedBoard.objects.length, 3);
    await pdfPagesMatch(originalAsset(autosaved.assetId), [
      { width: 240, height: 180, rotation: 90, marker: null },
    ]);
    assert.deepEqual(originalAsset(sourceImage.assetId), fixtures.png.bytes);
    await pdfPagesMatch(originalAsset(imagePdf.assetId), [
      { width: 240, height: 180, rotation: 0, marker: null },
    ]);
  } finally {
    persistedStore.close();
  }
  checkpoint('native app close flushes an unsaved PDF draft into a persisted sibling copy');
  completed = true;
  console.log('PDF_WORKSPACE_DESKTOP_OK', JSON.stringify({ root, executable, steps, errors }));
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
            workspace: await rect(workspace),
            pages: await tiles(),
            imageInputEvents: await read('window.__imageInputEvents || []'),
            imageTestPoint: await read('window.__imageTestPoint || null'),
            imageEditor: await read(
              `document.querySelector('textarea[aria-label="Edit image title"]')?.value || null`,
            ),
            errors,
            downloads: main ? await main.read('globalThis.__pdfWorkspaceDownloads?.calls') : [],
          },
          null,
          2,
        ),
      );
    } catch {}
  }
  console.error('PDF_WORKSPACE_DESKTOP_FAILED', root, error);
  throw error;
} finally {
  writeFileSync(join(root, 'diagnostics.log'), diagnostics);
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify({ completed, steps, errors, executable }, null, 2),
  );
  if (main) {
    try {
      await restoreHooks();
    } catch {}
  }
  renderer?.close();
  main?.close();
  // Only this test's child is terminated, never any pre-existing Terra process.
  child.kill();
  if (child.exitCode === null)
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
}
