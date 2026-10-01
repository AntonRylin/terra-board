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
store.patchBoard({
  id: board.id,
  revision: 0,
  deleted: [],
  upserts: [
    { id: 'left', type: 'image', x: 100, y: 150, width: 260, height: 240, z: 1, assetId: asset.id },
    {
      id: 'right',
      type: 'image',
      x: 600,
      y: 350,
      width: 260,
      height: 240,
      z: 2,
      assetId: asset.id,
    },
    {
      id: 'caption-left',
      type: 'text',
      x: 100,
      y: 420,
      width: 240,
      height: 40,
      z: 3,
      fontSize: 28,
      text: 'First image',
    },
    {
      id: 'caption-right',
      type: 'text',
      x: 600,
      y: 620,
      width: 240,
      height: 40,
      z: 4,
      fontSize: 28,
      text: 'Second image',
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
    } else if (m.method === 'Runtime.exceptionThrown')
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
  const host = await rect('.canvas-surface');

  const object = async (id) => (await documentState()).objects.find((o) => o.id === id);
  const capture = async (name) => {
    await sleep(150);
    writeFileSync(
      join(root, name + '.png'),
      Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
    );
  };
  await click(host.x + 160, host.y + 440);
  await clickSelector('[aria-label="Bold"]');
  await until(async () => (await object('caption-left')).bold, 'bold saved');
  await clickSelector('[aria-label="Strikethrough"]');
  await until(async () => (await object('caption-left')).strikethrough, 'strikethrough saved');
  await capture('formatted-text');
  await key('z', 'KeyZ', 2);
  await until(async () => !(await object('caption-left')).strikethrough, 'strike undo');
  await key('z', 'KeyZ', 10);
  await until(async () => (await object('caption-left')).strikethrough, 'strike redo');
  await click(host.x + 160, host.y + 440);
  await until(() => rect('.text-editor'), 'text editing');
  assert.equal(
    await read(`getComputedStyle(document.querySelector('.text-editor')).fontWeight`),
    '700',
  );
  assert.equal(
    await read(`getComputedStyle(document.querySelector('.text-editor')).textDecorationLine`),
    'line-through',
  );
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Edited bold text' });
  await clickSelector('[aria-label="Bold"]');
  assert.equal(await read(`document.activeElement.classList.contains('text-editor')`), true);
  assert.equal(await read(`document.querySelector('.text-editor').value`), 'Edited bold text');
  assert.equal(
    await read(`getComputedStyle(document.querySelector('.text-editor')).fontWeight`),
    '400',
  );
  await key('b', 'KeyB', 2);
  assert.equal(
    await read(`getComputedStyle(document.querySelector('.text-editor')).fontWeight`),
    '700',
  );
  await key('Enter', 'Enter', 2);
  await until(
    async () => (await object('caption-left')).text === 'Edited bold text',
    'edited text saved',
  );
  // Mixed selections enable formatting on all text and preserve unrelated images.
  await key('a', 'KeyA', 2);
  assert.equal(
    await read(`document.querySelector('[aria-label="Bold"]').getAttribute('aria-pressed')`),
    'mixed',
  );
  await clickSelector('[aria-label="Bold"]');
  await until(async () => (await object('caption-right')).bold, 'mixed selection bold');
  assert.equal((await object('left')).bold, undefined);
  await clickSelector('[aria-label="Strikethrough"]');
  await until(async () => (await object('caption-right')).strikethrough, 'mixed selection strike');
  await capture('formatted-selection');
  assert.deepEqual(errors, []);
  await closeWindow();
  await exited;
  const reopened = new Store(root);
  const saved = reopened.loadBoard({ id: board.id });
  reopened.close();
  for (const id of ['caption-left', 'caption-right']) {
    assert.equal(saved.objects.find((o) => o.id === id).bold, true);
    assert.equal(saved.objects.find((o) => o.id === id).strikethrough, true);
  }
  console.log(
    JSON.stringify({
      library: root,
      bold: true,
      strikethrough: true,
      undo: true,
      redo: true,
      liveEditor: true,
      mixedSelection: true,
      persisted: true,
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
