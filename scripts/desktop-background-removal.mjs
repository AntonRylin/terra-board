// End-to-end desktop checks; all mutations stay in an isolated library.
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
const root = mkdtempSync(resolve('.local-test/background-desktop-'));
const store = new Store(root);
const iconBytes = await sharp(
  Buffer.from(
    '<svg width="200" height="200"><rect width="200" height="200" fill="white"/><circle cx="100" cy="100" r="64" fill="#ed5040"/><circle cx="100" cy="100" r="28" fill="white"/></svg>',
  ),
)
  .png()
  .toBuffer();
const transparentBytes = await sharp(
  Buffer.from(
    '<svg width="240" height="160"><circle cx="120" cy="80" r="65" fill="#40a1df"/><circle cx="120" cy="80" r="20" fill="white"/></svg>',
  ),
)
  .png()
  .toBuffer();
const photoBytes = await sharp(
  Buffer.from(
    '<svg width="200" height="200"><defs><linearGradient id="bg"><stop stop-color="#dce6d0"/><stop offset="1" stop-color="#9baa97"/></linearGradient><linearGradient id="body"><stop stop-color="#a11c1c"/><stop offset="0.45" stop-color="#ed6355"/><stop offset="1" stop-color="#941c20"/></linearGradient></defs><rect width="200" height="200" fill="url(#bg)"/><ellipse cx="100" cy="170" rx="45" ry="8" fill="#61715b" opacity="0.3"/><path d="M85 30H115V50L130 66V158Q100 175 70 158V66L85 50Z" fill="url(#body)"/><rect x="83" y="22" width="34" height="16" rx="3" fill="#293443"/><rect x="75" y="82" width="50" height="50" rx="4" fill="#f6e9cb"/><circle cx="100" cy="107" r="16" fill="#c83b37"/></svg>',
  ),
)
  .png()
  .toBuffer();
const source = await store.importAsset({ bytes: photoBytes, name: 'Product.png' });
const iconSource = await store.importAsset({ bytes: iconBytes, name: 'Logo.png' });
const transparent = await store.importAsset({ bytes: transparentBytes, name: 'Transparent.png' });
const board = store.createBoard({ name: 'Background removal review' });
const object = {
  id: 'image-to-cut-out',
  type: 'image',
  assetId: source.id,
  x: 250,
  y: 160,
  width: 300,
  height: 300,
  rotation: 10,
  z: 1,
  imageTitle: 'Keep my title',
  crop: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
};
store.patchBoard({ id: board.id, revision: 0, upserts: [object], camera: { x: 0, y: 0, zoom: 1 } });
store.updateBoard({ id: board.id, patch: { icon: 'asset-' + iconSource.id, color: 'rose' } });
const folder = store.createFolder({ name: 'Icons' });
const transparentBoard = store.createBoard({ name: 'Transparent icon', folderId: folder.id });
store.updateBoard({
  id: transparentBoard.id,
  patch: { icon: 'asset-' + transparent.id, color: 'orange' },
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
const until = async (fn, label, timeout = 15000) => {
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
    }, 30000);
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
    throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const click = async (x, y, button = 'left') => {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button,
    buttons: button === 'right' ? 2 : 1,
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button,
    buttons: 0,
    clickCount: 1,
  });
};
const clickSelector = async (selector, button = 'left') => {
  const r = await read(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
  );
  assert.ok(r, selector);
  await click(r.x, r.y, button);
};
const clickText = async (text, container = 'document') => {
  const selector = await read(
    `(() => { const b=[...${container}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if (!b) return false; b.dataset.testAction='current'; return true; })()`,
  );
  assert.ok(selector, text);
  await clickSelector('[data-test-action="current"]');
  await read(
    `document.querySelector('[data-test-action="current"]')?.removeAttribute('data-test-action')`,
  );
};
const key = async (key, code, modifiers = 0) => {
  const windowsVirtualKeyCode = code.startsWith('Key')
    ? code.charCodeAt(3)
    : { Escape: 27, Delete: 46 }[code] || 0;
  for (const type of ['keyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode });
};
const documentState = () =>
  read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
const alpha = async (id) => {
  const file = join(root, 'assets', id + '.original');
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    corner: data[3],
    middle: data[(Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4 + 3],
    width: info.width,
    height: info.height,
  };
};
const screenshot = async (name) => {
  await sleep(240);
  const shot = await send('Page.captureScreenshot');
  writeFileSync(join(root, name + '.png'), Buffer.from(shot.data, 'base64'));
};
const dropIcon = async (bytes, name = 'Icon.png') => {
  await read(
    `(() => { const bytes=Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0)); const transfer=new DataTransfer(); transfer.items.add(new File([bytes],${JSON.stringify(name)},{type:'image/png'})); document.querySelector('.board-icon-upload').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer})); })()`,
  );
  await until(
    () =>
      read(
        `!!document.querySelector('.board-icon-crop img') && document.querySelector('.board-icon-upload')?.getAttribute('aria-busy')==='false'`,
      ),
    'icon upload',
  );
};
const iconId = () =>
  read(
    `window.canvas.invoke('library').then(l=>l.boards.find(b=>b.id===${JSON.stringify(board.id)}).icon.slice(6))`,
  );
const openIcon = async () => {
  await clickSelector(`[data-item="${board.id}"]`, 'right');
  await clickText('Change icon');
  await until(() => read(`!!document.querySelector('.board-icon-upload')`), 'icon dialog');
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
    width: 1280,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await until(
    () => read(`!!document.querySelector('canvas')&&!document.querySelector('.canvas-loading')`),
    'canvas ready',
  );
  await sleep(300);
  const host = await read(
    `(() => {const r=document.querySelector('.canvas-surface').getBoundingClientRect();return {x:r.x,y:r.y}})()`,
  );
  await click(host.x + 400, host.y + 290, 'right');
  await until(() => read(`!!document.querySelector('.context-menu')`), 'image context menu');
  await screenshot('image-menu');
  await clickText('Remove background');
  // Keep dragging beyond inference completion: the result must not overwrite
  // the gesture's snapshot or create a partial-move undo entry.
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: host.x + 400,
    y: host.y + 290,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: host.x + 460,
    y: host.y + 330,
    button: 'left',
    buttons: 1,
  });
  await until(
    () =>
      read(`document.querySelector('.import-status')?.textContent.includes('Removing background')`),
    'processing feedback',
  );
  const pingStart = Date.now();
  await read(`window.canvas.invoke('library')`);
  assert.ok(Date.now() - pingStart < 1000, 'storage remains responsive during inference');
  await sleep(1300);
  assert.equal((await documentState()).objects[0].assetId, source.id, 'waits for active drag');
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: host.x + 460,
    y: host.y + 330,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  object.x += 60;
  object.y += 40;
  const updated = await until(async () => {
    const d = await documentState();
    return d.objects[0]?.assetId !== source.id && d.objects[0];
  }, 'saved cutout');
  assert.deepEqual(
    { ...updated, assetId: source.id },
    object,
    'geometry, crop, rotation and title preserved',
  );
  assert.ok((await alpha(updated.assetId)).corner < 10);
  assert.ok((await alpha(updated.assetId)).middle > 240);
  await key('z', 'KeyZ', 2);
  await until(
    async () => (await documentState()).objects[0].assetId === source.id,
    'undo restores original',
  );
  await key('z', 'KeyZ', 10);
  await until(
    async () => (await documentState()).objects[0].assetId === updated.assetId,
    'redo restores cutout',
  );
  await screenshot('image-cutout');

  // Existing board icon: manual removal, reversible preview, then durable save.
  await openIcon();
  assert.equal(await read(`!!document.querySelector('.icon-background-setting')`), false);
  assert.ok(
    await read(
      `document.querySelector('.icon-background-action').getBoundingClientRect().height <= 30`,
    ),
  );
  await screenshot('compact-icon-actions');
  await clickText('Remove background');
  await until(
    () =>
      read(
        `document.querySelector('.icon-background-action')?.textContent.includes('Restore original')`,
      ),
    'manual icon removal',
  );
  await screenshot('icon-preview');
  await clickText('Restore original');
  assert.ok(
    await read(
      `document.querySelector('.board-icon-crop img').src.includes(${JSON.stringify(iconSource.id)})`,
    ),
  );
  await clickText('Remove background');
  await until(
    () => read(`document.querySelector('.board-icon-upload')?.getAttribute('aria-busy')==='false'`),
    'manual icon ready',
  );
  await clickSelector('.dialog-actions .primary');
  await until(() => read(`!document.querySelector('[role="dialog"]')`), 'icon saved');
  let saved = await iconId();
  assert.equal((await alpha(saved)).corner, 0);
  assert.equal((await alpha(saved)).middle, 255, 'white logo center preserved');
  assert.deepEqual(
    await read(
      `(() => { const s=getComputedStyle(document.querySelector('[data-item="${board.id}"] .app-icon')); return [s.backgroundColor,s.boxShadow]; })()`,
    ),
    ['rgba(0, 0, 0, 0)', 'none'],
  );

  // Old saved preferences cannot trigger removal: uploads stay manual.
  await read(`localStorage.setItem('terra-board.icon-remove-background','true')`);
  await openIcon();
  await dropIcon(iconBytes);
  assert.equal(
    await read(`document.querySelector('.icon-background-action').textContent.trim()`),
    'Remove background',
  );
  await clickSelector('.dialog-actions .primary');
  await until(() => read(`!document.querySelector('[role="dialog"]')`), 'opaque icon saved');
  assert.equal((await alpha(await iconId())).corner, 255);

  await openIcon();
  await dropIcon(iconBytes);
  await clickText('Remove background');
  await until(
    () => read(`document.querySelector('.board-icon-upload')?.getAttribute('aria-busy')==='false'`),
    'uploaded icon background removed',
  );
  assert.equal(
    await read(`document.querySelector('.icon-background-action').textContent.trim()`),
    'Restore original',
  );
  await clickSelector('.dialog-actions .primary');
  await until(() => read(`!document.querySelector('[role="dialog"]')`), 'uploaded cutout saved');
  assert.equal((await alpha(await iconId())).corner, 0);
  await openIcon();
  await dropIcon(transparentBytes);
  await clickSelector('.dialog-actions .primary');
  await until(() => read(`!document.querySelector('[role="dialog"]')`), 'transparent PNG saved');
  saved = await iconId();
  assert.equal((await alpha(saved)).corner, 0);
  assert.equal((await alpha(saved)).middle, 255);
  // A failed upload leaves the last usable image and save action intact.
  await openIcon();
  await read(
    `(() => {const t=new DataTransfer(); t.items.add(new File(['invalid'],'Broken.png',{type:'image/png'}));document.querySelector('.board-icon-upload').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:t}));})()`,
  );
  await until(
    () => read(`!!document.querySelector('.icon-upload-error')`),
    'failed upload feedback',
  );
  assert.equal(await read(`document.querySelector('.dialog-actions .primary').disabled`), false);
  await clickText('Cancel');
  assert.equal(await iconId(), saved);

  // Reload persisted PNGs; folder icons also reveal their surroundings.
  const loaded = new Promise((r) => {
    const listener = (e) => {
      if (JSON.parse(e.data).method === 'Page.loadEventFired') {
        socket.removeEventListener('message', listener);
        r();
      }
    };
    socket.addEventListener('message', listener);
  });
  await send('Page.reload');
  await loaded;
  await until(
    () => read(`!!document.querySelector('canvas')&&!document.querySelector('.canvas-loading')`),
    'reloaded canvas',
  );
  assert.equal(await iconId(), saved);
  await openIcon();
  assert.equal(await read(`!!document.querySelector('.icon-background-setting')`), false);
  await clickText('Cancel');
  await clickSelector(`[data-item="${folder.id}"]`);
  await until(
    () => read(`!!document.querySelector('.folder-board .board-image-icon')`),
    'folder icon',
  );
  assert.equal(
    await read(
      `getComputedStyle(document.querySelector('.folder-board .app-icon')).backgroundColor`,
    ),
    'rgba(0, 0, 0, 0)',
  );
  assert.equal(
    await read(
      `getComputedStyle(document.querySelector('.folder-board .board-image-icon')).objectFit`,
    ),
    'contain',
  );
  await screenshot('transparent-icons');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks:
        'Image menu, real local inference, storage responsiveness, geometry and crop, undo/redo, compact manual icon preview/restore/save, old automatic preference ignored, transparent PNG, failed upload, folder icons',
      artifacts: root,
    }),
  );
} catch (error) {
  console.error(error, diagnostics);
  if (socket?.readyState === 1) await screenshot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
