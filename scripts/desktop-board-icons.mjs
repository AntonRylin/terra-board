// Drive Chromium's real mouse/keyboard input in the packaged Electron app.
// Use an isolated repository-local library; never touch the user's boards.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-input-'));
const store = new Store(root);
const pixels = Buffer.alloc(512 * 256 * 3);
for (let y = 0; y < 256; y++)
  for (let x = 0; x < 512; x++) {
    const color =
      x < 256
        ? y < 128
          ? [227, 59, 54]
          : [54, 108, 220]
        : y < 128
          ? [42, 176, 106]
          : [241, 191, 48];
    pixels.set(color, (y * 512 + x) * 3);
  }
const asset = await store.importAsset({
  name: 'Quadrants.png',
  bytes: await sharp(pixels, { raw: { width: 512, height: 256, channels: 3 } })
    .png()
    .toBuffer(),
});
const board = store.createBoard({ name: 'Desktop input verification' });
const folder = store.createFolder({ name: 'Icon folder' });
const folderBoard = store.createBoard({ name: 'Folder icon target', folderId: folder.id });
store.patchBoard({
  id: board.id,
  revision: 0,
  deleted: [],
  upserts: [
    {
      id: 'text',
      type: 'text',
      x: 60,
      y: 70,
      width: 300,
      height: 60,
      z: 1,
      text: 'Double-click text',
      fontSize: 24,
    },
    {
      id: 'note',
      type: 'note',
      x: 60,
      y: 190,
      width: 260,
      height: 240,
      z: 2,
      text: 'Double-click note',
      fontSize: 21,
      color: '#f8efd4',
    },
    {
      id: 'frame',
      type: 'frame',
      x: 390,
      y: 70,
      width: 300,
      height: 230,
      z: 0,
      text: 'Double-click frame',
      fontSize: 14,
    },
    {
      id: 'shape',
      type: 'rect',
      x: 390,
      y: 330,
      width: 240,
      height: 130,
      z: 3,
      text: 'Double-click shape',
    },
    {
      id: 'image',
      type: 'image',
      x: 700,
      y: 360,
      width: 480,
      height: 240,
      z: 4,
      assetId: asset.id,
    },
  ],
});
store.setLastBoard({ id: board.id });
store.close();
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const executable = process.env.CANVAS_EXECUTABLE || resolve('release/win-unpacked/Terra Board.exe');
const env = { ...process.env, CANVAS_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const child = spawn(executable, [`--remote-debugging-port=${port}`], {
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let diagnostics = '';
child.stderr.on('data', (b) => (diagnostics += b));
child.stdout.on('data', () => {});
const exited = new Promise((r) => child.once('exit', r));
// Send the same WM_CLOSE as the title-bar X. Get-Process.MainWindowHandle
// omits hidden test windows, and Page.close bypasses Electron's close guard.
const closeWindow = () =>
  new Promise((resolve, reject) => {
    const script = `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CanvasTestClose {
  delegate bool Callback(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
  public static int Close(int owner) {
    int count=0;
    EnumWindows((hwnd,data) => {uint pid;GetWindowThreadProcessId(hwnd,out pid);if(pid==(uint)owner){var name=new StringBuilder(256);GetClassName(hwnd,name,256);if(name.ToString()=="Chrome_WidgetWin_1"){PostMessage(hwnd,0x0010,IntPtr.Zero,IntPtr.Zero);count++;}}return true;},IntPtr.Zero);
    return count;
  }
}
'@
if ([CanvasTestClose]::Close(${child.pid}) -eq 0) { exit 1 }`;
    const closer = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, TEMP: join(root, 'temp'), TMP: join(root, 'temp') },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    closer.stderr.on('data', (b) => (error += b));
    closer.once('exit', (code) =>
      code === 0 ? resolve() : reject(Error('Native close request failed: ' + error)),
    );
  });
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
  chooser,
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
const doubleClick = async (x, y) => {
  await click(x, y);
  await sleep(60);
  // Already-selected plain text opens on that single click. Do not add a
  // second click inside its newly focused textarea and change the selection.
  if (await read(`!!document.querySelector('.text-editor')`)) return;
  await click(x, y, 'left', 2);
  await sleep(100);
};
const clickSelector = async (selector) => {
  await read(
    `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest'})`,
  );
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
const documentState = () =>
  read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
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
    } else if (m.method === 'Page.fileChooserOpened') chooser = m.params;
    else if (m.method === 'Runtime.exceptionThrown')
      errors.push(
        m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text,
      );
  });
  await send('Runtime.enable');
  await until(
    () => read(`!!document.querySelector('canvas')&&!document.querySelector('.canvas-loading')`),
    'canvas ready',
  );
  await read(
    `window.inputLog=[];document.addEventListener('dblclick',e=>inputLog.push({target:e.target.className||e.target.tagName,trusted:e.isTrusted}),true);`,
  );
  const initial = await documentState();
  const openIcon = async () => {
    const r = await rect('[aria-label="Open board Desktop input verification"]');
    await click(r.x + r.width / 2, r.y + r.height / 2, 'right');
    await read(
      `(()=>{[...document.querySelectorAll('.context-menu button')].find(b=>b.textContent.trim()==='Change icon').click()})()`,
    );
    await until(() => read(`!!document.querySelector('.board-icon-upload')`), 'icon dialog');
  };
  const drop = async () =>
    read(
      `(async()=>{const response=await fetch('canvas-media://asset/${asset.id}/original');const blob=await response.blob();const data=new DataTransfer();data.items.add(new File([blob],'quadrants.png',{type:'image/png'}));document.querySelector('.board-icon-upload').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));})()`,
    );
  const nativeDrop = async (selector) => {
    const target = await rect(selector);
    const data = {
      items: [],
      files: [join(root, 'assets', asset.id + '.original')],
      dragOperationsMask: 1,
    };
    for (const type of ['dragEnter', 'dragOver', 'drop'])
      await send('Input.dispatchDragEvent', {
        type,
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
        data,
      });
  };
  await nativeDrop('[aria-label="Open board Desktop input verification"]');
  await until(
    () => read(`!!document.querySelector('.board-icon-crop')`),
    'crop after sidebar file drop',
    4000,
  );
  assert.equal(
    (await documentState()).board.icon,
    initial.board.icon,
    'draft does not change saved icon',
  );
  await read(
    `(()=>{const e=document.querySelector('[aria-label="Icon zoom"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'2');e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await clickSelector('.icon-shape-picker button:last-child');
  await clickSelector('.tone-picker [aria-label="yellow"]');
  await until(
    () => read(`document.querySelector('.board-icon-crop').classList.contains('shape-circle')`),
    'circle crop mask',
  );
  const r = await rect('.board-icon-crop');
  const before = await read(`document.querySelector('.board-icon-crop img').style.left`);
  await mouse('mousePressed', r.x + 100, r.y + 100);
  await mouse('mouseMoved', r.x + 150, r.y + 120);
  await mouse('mouseReleased', r.x + 150, r.y + 120);
  await until(
    async () =>
      (await read(`document.querySelector('.board-icon-crop img').style.left`)) !== before,
    'crop drag renders',
  );
  writeFileSync(
    join(root, 'icon-crop.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await clickSelector('.dialog-actions .primary');
  const saved = await until(async () => {
    const d = await documentState();
    return d.board.icon.startsWith('asset-') ? d : null;
  }, 'saved custom icon');
  assert.equal(saved.board.iconShape, 'circle');
  assert.equal(saved.board.color, 'yellow');
  assert.equal(saved.objects.length, initial.objects.length, 'drop must not import onto canvas');
  await until(
    () => read(`document.querySelector('.launch-item .board-image-icon')?.naturalWidth > 0`),
    'launcher image loaded',
  );
  const stored = new Store(root);
  const icon = stored.asset({ id: saved.board.icon.slice(6), variant: 'original' });
  const metadata = await sharp(icon.file).metadata();
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 512);
  const exported = await stored.exportBoard({ id: board.id });
  const destination = new Store(join(root, 'portable-copy'));
  const copy = await destination.importBoard({ bytes: exported });
  assert.equal(copy.icon, saved.board.icon);
  destination.close();
  stored.close();
  await openIcon();
  await drop();
  await until(() => read(`!!document.querySelector('.board-icon-crop')`), 'replacement draft');
  await clickSelector('.dialog-actions .button:not(.primary)');
  await until(() => read(`!document.querySelector('.modal')`), 'cancel closes dialog');
  assert.equal((await documentState()).board.icon, saved.board.icon, 'cancel preserves icon');
  await openIcon();
  await clickSelector('.icon-picker [aria-label="rocket"]');
  await clickSelector('.dialog-actions .primary');
  await until(async () => (await documentState()).board.icon === 'rocket', 'restore built-in icon');
  await openIcon();
  await clickSelector('.icon-picker [aria-label="rocket"]');
  assert.equal(
    await read(`document.querySelector('.icon-preview').children.length`),
    0,
    'selected icon toggles off',
  );
  await clickSelector('.tone-picker [aria-label="green"]');
  await clickSelector('.dialog-actions .primary');
  await until(async () => (await documentState()).board.icon === 'none', 'color-only icon saved');
  assert.equal((await documentState()).board.color, 'green');
  assert.equal(
    await read(`document.querySelector('.board-glyph').children.length`),
    0,
    'header has no fallback glyph',
  );
  await openIcon();
  await clickSelector('[aria-label="Use emoji 🌿"]');
  await clickSelector('.dialog-actions .primary');
  await until(async () => (await documentState()).board.icon === 'emoji:🌿', 'emoji saved');
  assert.equal(await read(`document.querySelector('.board-glyph .board-emoji').textContent`), '🌿');
  await openIcon();
  await clickSelector('[aria-label="Use emoji 🌿"]');
  assert.equal(
    await read(`document.querySelector('.icon-preview').children.length`),
    0,
    'emoji toggles off',
  );
  const iconDialogBounds = await read(
    `({width: document.querySelector('.modal').offsetWidth, height: document.querySelector('.modal').offsetHeight})`,
  );
  await clickSelector('[aria-label="More emojis"]');
  assert.equal(
    await read(`document.querySelectorAll('.emoji-panel .emoji-choice').length > 900`),
    true,
  );
  assert.equal(
    await read(
      `document.querySelector('.emoji-panel').getBoundingClientRect().width > document.querySelector('.modal').getBoundingClientRect().width`,
    ),
    true,
    'overlay is wider than icon dialog',
  );
  assert.deepEqual(
    await read(
      `({width: document.querySelector('.modal').offsetWidth, height: document.querySelector('.modal').offsetHeight})`,
    ),
    iconDialogBounds,
    'overlay does not expand the icon form',
  );
  await key('Tab', 'Tab', 8);
  assert.equal(
    await read(`document.activeElement.getAttribute('aria-label')`),
    'Custom emoji',
    'focus stays inside overlay',
  );
  await key('Escape', 'Escape');
  assert.equal(
    await read(`!document.querySelector('.emoji-overlay') && !!document.querySelector('.modal')`),
    true,
    'Escape only closes emoji overlay',
  );
  await clickSelector('[aria-label="More emojis"]');
  writeFileSync(
    join(root, 'emoji-overlay.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await clickSelector('.emoji-panel [aria-label="Use emoji 🥰"]');
  assert.equal(
    await read(`!document.querySelector('.emoji-overlay')`),
    true,
    'picking returns to icon dialog',
  );
  await clickSelector('[aria-label="More emojis"]');
  await clickSelector('[aria-label="Custom emoji"]');
  await send('Input.insertText', { text: '👩🏽‍💻' });
  await clickSelector('.emoji-custom button');
  assert.equal(
    await read(`document.querySelector('.icon-preview .board-emoji').textContent`),
    '👩🏽‍💻',
  );
  await read(`document.querySelector('.modal').scrollTop=0`);
  writeFileSync(
    join(root, 'emoji-picker.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await clickSelector('.dialog-actions .primary');
  await until(async () => (await documentState()).board.icon === 'emoji:👩🏽‍💻', 'custom emoji saved');
  await openIcon();
  await clickSelector('[aria-label="Remove selected icon"]');
  await clickSelector('.dialog-actions .primary');
  await until(
    async () => (await documentState()).board.icon === 'none',
    'preview removes selected emoji',
  );
  await openIcon();
  await send('Page.enable');
  await send('Page.setInterceptFileChooserDialog', { enabled: true });
  await clickSelector('.board-icon-upload > .button');
  await until(() => chooser, 'upload opens file chooser');
  await send('DOM.setFileInputFiles', {
    backendNodeId: chooser.backendNodeId,
    files: [join(root, 'assets', asset.id + '.original')],
  });
  await until(() => read(`!!document.querySelector('.board-icon-crop')`), 'file picker opens crop');
  await clickSelector('.dialog-actions .primary');
  await until(
    async () => (await documentState()).board.icon.startsWith('asset-'),
    'upload saves image',
  );
  await until(() => read(`!document.querySelector('.modal')`), 'upload dialog closes');
  const mainIcon = (await documentState()).board.icon;
  await clickSelector('[aria-label="Open folder Icon folder"]');
  await nativeDrop('[aria-label="Open board Folder icon target"]');
  await until(
    () => read(`!!document.querySelector('.board-icon-crop')`),
    'crop after folder board drop',
  );
  await clickSelector('.dialog-actions .primary');
  await until(
    async () =>
      (
        await read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(folderBoard.id)}})`)
      ).board.icon.startsWith('asset-'),
    'folder board icon saved',
  );
  assert.equal(
    (await documentState()).board.icon,
    mainIcon,
    'dropping on another board preserves active board',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      root,
      drop: true,
      cropDrag: true,
      zoom: true,
      save: true,
      cancel: true,
      builtIn: true,
      portable: true,
      errors,
    }),
  );
} catch (error) {
  console.error(error);
  try {
    console.error(JSON.stringify(await documentState()));
    const failure = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(root, 'failure.png'), Buffer.from(failure.data, 'base64'));
  } catch {}
  console.error(diagnostics.slice(-2000));
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) {
    try {
      await closeWindow();
    } catch {}
    await Promise.race([exited, sleep(3000)]);
    if (child.exitCode === null) child.kill();
  }
  socket?.close();
}
