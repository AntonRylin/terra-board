// Live-network preview verification in a disposable library.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-links-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Link previews' });
store.createBoard({ name: 'Other board' });
store.patchBoard({
  id: board.id,
  revision: 0,
  deleted: [],
  upserts: [
    {
      id: 'trends-recovery',
      type: 'link',
      x: 550,
      y: 100,
      width: 440,
      height: 112,
      z: 2,
      url: 'https://trends.google.com/trends/',
      text: 'Google Trends',
      linkDescription:
        'Explore search interest of terms and topics by time, location and popularity on Google Trends',
    },
    {
      id: 'recovery',
      type: 'link',
      x: 50,
      y: 100,
      width: 440,
      height: 314,
      z: 1,
      url: 'https://www.youtube.com/watch?v=YLz9IdSQ7IM',
      text: 'www.youtube.com',
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw Error('Timed out: ' + label);
}
let socket,
  seq = 0;
const pending = new Map(),
  errors = [],
  contexts = new Map();
function send(method, params = {}, sessionId) {
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
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function read(expression, sessionId, contextId) {
  const r = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, contextId },
    sessionId,
  );
  if (r.exceptionDetails)
    throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function click(selector) {
  const p = await read(
    `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, buttons: 0 });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...p,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...p,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
}
const state = () => read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
async function linkMenuAction(o, label) {
  const origin = await read(
    `(()=>{const r=document.querySelector('.canvas-surface').getBoundingClientRect();return {x:r.x,y:r.y}})()`,
  );
  const p = { x: origin.x + o.x + o.width / 2, y: origin.y + o.y + 24 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, buttons: 0 });
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
  const index = await until(
    () =>
      read(
        `(()=>{const b=[...document.querySelectorAll('.context-menu button')];return b.findIndex(e=>e.textContent.trim()===${JSON.stringify(label)})+1})()`,
      ),
    label,
  );
  await click(`.context-menu button:nth-of-type(${index})`);
}
const paste = (url) =>
  read(
    `(()=>{const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(url)});document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));})()`,
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
    } else if (m.method === 'Runtime.exceptionThrown' && !m.sessionId)
      errors.push(m.params.exceptionDetails.text);
    else if (m.method === 'Runtime.executionContextCreated')
      contexts.set(m.params.context.id, m.params.context);
    else if (m.method === 'Runtime.executionContextDestroyed')
      contexts.delete(m.params.executionContextId);
  });
  await send('Runtime.enable');
  await until(() => read(`!!document.querySelector('.canvas-surface canvas')`), 'canvas');
  const recovered = await until(async () => {
    const object = (await state()).objects.find((o) => o.id === 'recovery');
    return object?.assetId && object.text.includes('+1 Speed') ? object : null;
  }, 'saved incomplete card gets a title and thumbnail without any click');
  const trends = await until(async () => {
    const o = (await state()).objects.find((o) => o.id === 'trends-recovery');
    return o?.assetId && o.linkIconId && o.height === 314 ? o : null;
  }, 'saved Google Trends card recovers its ICO logo and a page image');
  assert.equal(
    await read(`!!document.querySelector('.board-link-player')`),
    false,
    'repair must not start playback',
  );
  await sleep(700);
  writeFileSync(
    join(root, 'recovered-thumbnail.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  writeFileSync(
    join(root, 'trends-preview.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await linkMenuAction(trends, 'Show compact card');
  const compactTrends = await until(async () => {
    const o = (await state()).objects.find((o) => o.id === trends.id);
    return o.linkCompact && o.height === 112 ? o : null;
  }, 'right-click switches to a compact card');
  assert.equal(compactTrends.assetId, trends.assetId);
  assert.equal(compactTrends.linkPreviewHeight, trends.height);
  writeFileSync(
    join(root, 'trends-compact.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await linkMenuAction(compactTrends, 'Undo');
  await until(
    async () => !(await state()).objects.find((o) => o.id === trends.id).linkCompact,
    'undo restores preview',
  );
  await linkMenuAction(trends, 'Show compact card');
  await until(
    async () => (await state()).objects.find((o) => o.id === trends.id).linkCompact,
    'compact again',
  );
  await linkMenuAction(compactTrends, 'Show image preview');
  await until(async () => {
    const o = (await state()).objects.find((o) => o.id === trends.id);
    return !o.linkCompact && o.height === trends.height;
  }, 'right-click restores saved preview height');
  await linkMenuAction(trends, 'Show compact card');
  await until(
    async () => (await state()).objects.find((o) => o.id === trends.id).linkCompact,
    'compact choice saved',
  );
  await click('[aria-label="Open board Other board"]');
  await until(() => read(`!!document.querySelector('.empty-canvas')`), 'switch to another board');
  await click('[aria-label="Open board Link previews"]');
  await until(
    () =>
      read(
        `!!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading')`,
      ),
    'canvas reopens',
  );
  assert.equal((await state()).objects.find((o) => o.id === trends.id).linkCompact, true);
  await paste('https://example.com/');
  const compact = await until(
    async () => (await state()).objects.find((o) => o.url === 'https://example.com/'),
    'compact placeholder',
  );
  assert.equal(compact.height, 76);
  assert.equal(
    await read(`document.querySelector('.canvas-surface').getAttribute('aria-busy')`),
    'true',
  );
  const loadingClip = await read(
    `(()=>{const r=document.querySelector('.canvas-surface').getBoundingClientRect();return {x:r.x+${compact.x}+12,y:r.y+${compact.y}+21,width:34,height:34,scale:1}})()`,
  );
  const loadingA = (await send('Page.captureScreenshot', { format: 'png', clip: loadingClip }))
    .data;
  await sleep(160);
  const loadingB = (await send('Page.captureScreenshot', { format: 'png', clip: loadingClip }))
    .data;
  assert.notEqual(loadingA, loadingB, 'spinner must animate while fetching');
  writeFileSync(
    join(root, 'loading-preview.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await until(
    () => read(`document.querySelector('.canvas-surface').getAttribute('aria-busy')==='false'`),
    'preview loading finishes',
  );
  const noImage = (await state()).objects.find((o) => o.id === compact.id);
  assert.equal(noImage.height, 76);
  assert.equal(noImage.assetId, undefined);
  writeFileSync(
    join(root, 'compact-link.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Delete',
    code: 'Delete',
    windowsVirtualKeyCode: 46,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Delete',
    code: 'Delete',
    windowsVirtualKeyCode: 46,
  });
  await paste('https://www.google.com/');
  const google = await until(async () => {
    const o = (await state()).objects.find((o) => o.url === 'https://www.google.com/');
    return o?.linkIconId && o.linkDescription && o.height === 112 ? o : null;
  }, 'Google logo and text summary without a thumbnail');
  assert.equal(google.assetId, undefined);
  await sleep(700);
  writeFileSync(
    join(root, 'google-summary.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  const canvasOrigin = await read(
    `(()=>{const r=document.querySelector('.canvas-surface').getBoundingClientRect();return {x:r.x,y:r.y}})()`,
  );
  const start = { x: google.x - 28, y: google.y + google.height + 28 };
  const center = { x: google.x + google.width / 2, y: google.y + google.height / 2 };
  const dx = start.x - center.x,
    dy = start.y - center.y,
    angle = Math.PI / 6;
  const end = {
    x: center.x + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: center.y + dx * Math.sin(angle) + dy * Math.cos(angle),
  };
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: canvasOrigin.x + start.x,
    y: canvasOrigin.y + start.y,
    buttons: 0,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: canvasOrigin.x + start.x,
    y: canvasOrigin.y + start.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: canvasOrigin.x + end.x,
    y: canvasOrigin.y + end.y,
    button: 'left',
    buttons: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: canvasOrigin.x + end.x,
    y: canvasOrigin.y + end.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await until(
    async () =>
      Math.abs((await state()).objects.find((o) => o.id === google.id).rotation - 30) < 0.5,
    'rounded card rotates with selection outline',
  );
  writeFileSync(
    join(root, 'google-rounded-rotated.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await paste('https://www.youtube.com/watch?v=jNQXAC9IVRw');
  await until(
    () => read(`!!document.querySelector('.board-link-player iframe')`),
    'automatic inline preview',
  );
  const mutedContext = await until(
    async () => {
      const frame = (await send('Target.getTargets')).targetInfos.find(
        (t) => t.type === 'iframe' && t.url.includes('youtube-nocookie'),
      );
      if (frame) return send('Target.attachToTarget', { targetId: frame.targetId, flatten: true });
      return [...contexts.values()].find(
        (c) => c.origin.includes('youtube-nocookie') && c.auxData?.isDefault,
      );
    },
    'muted preview context',
    8000,
  );
  const mutedPreview = await until(
    () =>
      read(
        `(()=>{const v=document.querySelector('video');return v&&v.currentTime>0.2&&v.muted&&!v.paused?{time:v.currentTime,muted:v.muted}:null})()`,
        mutedContext.sessionId,
        mutedContext.id,
      ),
    'muted preview is playing',
  );
  await until(
    () =>
      read(
        `(()=>{const v=document.querySelector('video');return !!v&&v.currentTime>=7.8&&v.paused})()`,
        mutedContext.sessionId,
        mutedContext.id,
      ),
    'preview stops after eight seconds',
    12000,
  );
  await click('.board-player-controls button'); // Full playback, with sound.
  await sleep(700); // The iframe is replaced; let Chromium discard its old target.
  const youtube = await until(async () => {
    const o = (await state()).objects.find(
      (o) => o.url === 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    );
    return o?.assetId && o.text === 'Me at the zoo' ? o : null;
  }, 'YouTube title and locally saved thumbnail');
  const targets = await send('Target.getTargets');
  const frame = targets.targetInfos.find(
    (t) => t.type === 'iframe' && t.url.includes('youtube-nocookie'),
  );
  let playback;
  if (frame) {
    const { sessionId } = await send('Target.attachToTarget', {
      targetId: frame.targetId,
      flatten: true,
    });
    playback = await until(
      () =>
        read(
          `(()=>{const v=document.querySelector('video');return v&&v.currentTime>0.2?{time:v.currentTime,paused:v.paused}:null})()`,
          sessionId,
        ),
      'video is playing',
      20000,
    );
  } else {
    const ctx = await until(
      () =>
        [...contexts.values()].find(
          (c) => c.origin.includes('youtube-nocookie') && c.auxData?.isDefault,
        ),
      'player execution context',
    );
    playback = await until(
      () =>
        read(
          `(()=>{const v=document.querySelector('video');return v&&v.currentTime>0.2&&!v.paused?{time:v.currentTime,paused:v.paused}:null})()`,
          undefined,
          ctx.id,
        ),
      'video is playing',
      20000,
    );
  }
  writeFileSync(
    join(root, 'inline-player.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await click('[aria-label="Close video preview"]');
  await paste('https://www.wikipedia.org/');
  const wiki = await until(async () => {
    const o = (await state()).objects.find((o) => o.url === 'https://www.wikipedia.org/');
    return o?.assetId && o.linkDescription ? o : null;
  }, 'ordinary website rich preview');
  assert.match(wiki.text, /Wikipedia/);
  // Move the selected second card right with real pointer input to inspect both cards.
  const host = await read(
    `(()=>{const r=document.querySelector('.canvas-surface').getBoundingClientRect();return {x:r.x,y:r.y}})()`,
  );
  const from = { x: host.x + wiki.x + 30, y: host.y + wiki.y + 20 };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from, buttons: 0 });
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...from,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: from.x + 460,
    y: from.y,
    button: 'left',
    buttons: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: from.x + 460,
    y: from.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await sleep(300);
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: '0',
    code: 'Digit0',
    windowsVirtualKeyCode: 48,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: '0',
    code: 'Digit0',
    windowsVirtualKeyCode: 48,
  });
  await sleep(500);
  writeFileSync(
    join(root, 'link-cards.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  const reopened = new Store(root);
  const portable = await reopened.exportBoard({ id: board.id });
  reopened.close();
  const importedStore = new Store(join(root, 'roundtrip'));
  const imported = await importedStore.importBoard({ bytes: portable });
  const importedObjects = importedStore.loadBoard({ id: imported.id }).objects;
  assert.equal(importedObjects.find((o) => o.id === youtube.id).assetId, youtube.assetId);
  assert.equal(importedObjects.find((o) => o.id === wiki.id).linkDescription, wiki.linkDescription);
  const importedGoogle = importedObjects.find((o) => o.id === google.id);
  assert.equal(importedGoogle.linkIconId, google.linkIconId);
  assert.equal(importedGoogle.linkDescription, google.linkDescription);
  assert.equal(importedObjects.find((o) => o.id === trends.id).linkIconId, trends.linkIconId);
  assert.equal(importedObjects.find((o) => o.id === trends.id).linkCompact, true);
  assert.equal(importedObjects.find((o) => o.id === trends.id).linkPreviewHeight, trends.height);
  assert.ok(importedStore.asset({ id: trends.assetId, variant: 'preview' }).file);
  assert.ok(importedStore.asset({ id: trends.linkIconId, variant: 'thumb' }).file);
  assert.ok(importedStore.asset({ id: google.linkIconId, variant: 'thumb' }).file);
  importedStore.close();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      { library: root, recovered, trends, google, youtube, wiki, mutedPreview, playback, errors },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(e);
  if (socket)
    try {
      console.error('App state:', await read('document.body.innerText'));
    } catch {}
  console.error('Contexts', [...contexts.values()]);
  if (socket)
    try {
      console.error(await send('Target.getTargets'));
      writeFileSync(
        join(root, 'failure.png'),
        Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
      );
    } catch {}
  console.error('Library:', root);
  process.exitCode = 1;
} finally {
  // Only this disposable fixture process is stopped; it never opens user boards.
  socket?.close();
  child.kill();
}
