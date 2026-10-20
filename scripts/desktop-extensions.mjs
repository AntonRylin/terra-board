// Settings → Extensions in the packaged app: install and remove through the
// UI, from the local build output (release/extensions), into a scratch
// Extensions folder. Also runs a real cut-out through the installed Background
// removal extension and removes it right after, which only works when the cut-out
// process released the runtime's DLLs.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/extensions-desktop-'));
const extensionsDir = join(root, 'Extensions');
const store = new Store(root);
const photo = await store.importAsset({
  name: 'Photo.png',
  bytes: await sharp(
    Buffer.from(
      '<svg width="200" height="200"><defs><linearGradient id="bg"><stop stop-color="#dce6d0"/><stop offset="1" stop-color="#9baa97"/></linearGradient></defs><rect width="200" height="200" fill="url(#bg)"/><path d="M85 30H115V50L130 66V158Q100 175 70 158V66L85 50Z" fill="#c83b37"/><rect x="75" y="82" width="50" height="50" rx="4" fill="#f6e9cb"/></svg>',
    ),
  )
    .png()
    .toBuffer(),
});
const board = store.createBoard({ name: 'Extensions check' });
store.patchBoard({
  id: board.id,
  revision: 0,
  upserts: [
    {
      id: 'photo',
      type: 'image',
      x: 200,
      y: 160,
      width: 200,
      height: 200,
      z: 1,
      assetId: photo.id,
    },
  ],
});
store.setLastBoard({ id: board.id });
store.close();

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const env = {
  ...process.env,
  CANVAS_DATA_DIR: root,
  TERRA_EXTENSIONS_DIR: extensionsDir,
  TERRA_EXTENSIONS_SOURCE: resolve('release/extensions'),
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const executable = process.env.CANVAS_EXECUTABLE || require('electron');
const child = spawn(
  executable,
  [
    ...(process.env.CANVAS_EXECUTABLE ? [] : ['.']),
    `--remote-debugging-port=${port}`,
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
  { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let diagnostics = '';
child.stderr.on('data', (b) => (diagnostics += b));
child.stdout.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
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
      }, 60000);
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
const click = async (selector) => {
  const r = await read(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  assert.ok(r, selector);
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', {
      type,
      x: r.x,
      y: r.y,
      button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1,
    });
};
const row = (id) => `[data-setting="${id}"]`;
const button = (id) => `${row(id)} .st-row-control button:last-child`;
const buttonText = (id) =>
  read(`document.querySelector(${JSON.stringify(button(id))})?.textContent.trim()`);
const installedChip = (id) =>
  read(`!!document.querySelector(${JSON.stringify(row(id) + ' .st-chip')})`);
const screenshot = async (name) => {
  await sleep(250);
  const shot = await send('Page.captureScreenshot');
  writeFileSync(join(root, name + '.png'), Buffer.from(shot.data, 'base64'));
};
const cutOut = () =>
  read(
    `window.canvas.invoke('removeBackground',{id:${JSON.stringify(photo.id)}}).then(a=>({id:a.id}),e=>({error:String(e)}))`,
  );
try {
  const target = await until(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === 'page' && t.url.startsWith('canvas-app:'),
      );
    } catch {
      return null;
    }
  }, 'app page');
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

  // Without the extension, photos ask for it.
  const missing = await cutOut();
  assert.match(missing.error, /Install Background removal in Settings → Extensions/);

  // Ctrl+, opens Settings; the Extensions section lists all three.
  for (const type of ['keyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', {
      type,
      key: ',',
      code: 'Comma',
      modifiers: 2,
      windowsVirtualKeyCode: 188,
    });
  await until(() => read(`!!document.querySelector('.st-nav')`), 'settings');
  await read(
    `Array.from(document.querySelectorAll('.st-nav-item')).find(b=>b.textContent.trim()==='Extensions').click()`,
  );
  for (const id of ['extensionBackgroundRemoval', 'extensionSongLinks', 'extensionOfficeFiles'])
    await until(() => read(`!!document.querySelector(${JSON.stringify(row(id))})`), id);
  assert.equal(await buttonText('extensionSongLinks'), 'Install');
  await screenshot('extensions-available');

  // Song links: install, then remove, through the buttons.
  await click(button('extensionSongLinks'));
  await until(() => installedChip('extensionSongLinks'), 'song links installed');
  assert.ok(existsSync(join(extensionsDir, 'song-links', 'yt-dlp.exe')));
  assert.equal(await buttonText('extensionSongLinks'), 'Remove');
  const licenses = await read(`window.canvas.licenses().then(l=>l.map(p=>p.name))`);
  assert.ok(licenses.includes('yt-dlp'), 'the licenses page lists installed extensions');
  await click(button('extensionSongLinks'));
  await until(
    async () => (await buttonText('extensionSongLinks')) === 'Install',
    'song links removed',
  );
  assert.ok(!existsSync(join(extensionsDir, 'song-links')));

  // Background removal: install, cut out a photo, remove right away.
  await click(button('extensionBackgroundRemoval'));
  await until(
    () => installedChip('extensionBackgroundRemoval'),
    'background removal installed',
    120000,
  );
  await screenshot('extensions-installed');
  const cut = await cutOut();
  assert.ok(cut.id && cut.id !== photo.id, `cut-out: ${JSON.stringify(cut)}`);
  await click(button('extensionBackgroundRemoval'));
  await until(
    async () => (await buttonText('extensionBackgroundRemoval')) === 'Install',
    'background removal removed',
  );
  await until(
    () => !existsSync(join(extensionsDir, 'background-removal')),
    'background removal folder deleted (no locked DLLs)',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      checks:
        'photo cut-out asks for the extension, Settings → Extensions lists 3, Song links install/remove through the UI, licenses list it, Background removal install, real cut-out in a utility process, immediate removal',
      artifacts: root,
    }),
  );
} catch (error) {
  console.error(error, diagnostics.slice(-2000));
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
