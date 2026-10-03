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
const executable =
  process.env.CANVAS_EXECUTABLE || resolve('release/win-unpacked/Terra Board.exe');
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
  await click(host.x + 80, host.y + 90);
  assert.equal(
    await read(`!!document.querySelector('.text-editor')`),
    false,
    'first text click should only select',
  );
  assert.equal(
    await read(`!!document.querySelector('.selection-tools [aria-label="Edit text"]')`),
    false,
    'plain text still has pencil button',
  );
  await sleep(800);
  await click(host.x + 80, host.y + 90);
  await until(
    () => read(`document.activeElement===document.querySelector('.text-editor')`),
    'single click on already-selected text opens editor',
  );
  await key('Escape', 'Escape');
  await click(host.x + 1050, host.y + 180);
  for (const [id, x, y] of [
    ['text', 80, 90],
    ['note', 90, 215],
    ['frame', 430, 92],
    ['shape', 430, 365],
  ]) {
    await click(host.x + 1050, host.y + 180);
    await click(host.x + x, host.y + y);
    assert.equal(
      await read(`!!document.querySelector('.text-editor')`),
      false,
      `${id} first click should select`,
    );
    assert.equal(
      await read(`!!document.querySelector('.selection-tools [aria-label="Edit text"]')`),
      false,
      `${id} still has pencil button`,
    );
    await sleep(800);
    await click(host.x + x, host.y + y);
    const editor = await read(
      `(()=>{const e=document.querySelector('.text-editor');return e?{value:e.value,focused:e===document.activeElement,start:e.selectionStart,end:e.selectionEnd}:null;})()`,
    );
    assert.ok(
      editor?.focused,
      `${id} double click failed: ${JSON.stringify(await read('window.inputLog'))}`,
    );
    assert.equal(editor.start, editor.value.length, `${id} caret is not at end`);
    assert.equal(editor.end, editor.value.length, `${id} existing text selected`);
    await send('Input.insertText', { text: ' appended' });
    assert.equal(
      await read(`document.querySelector('.text-editor').value`),
      editor.value + ' appended',
      `${id} typing replaced existing text`,
    );
    assert.ok(
      await read(
        `(()=>{const e=document.querySelector('.selection-tools');return e&&getComputedStyle(e).visibility==='visible';})()`,
      ),
      `${id} editor lost selection toolbar`,
    );
    const value = id === 'note' ? 'The full note stays inside. '.repeat(35) : 'Edited ' + id;
    await key('a', 'KeyA', 2);
    await send('Input.insertText', { text: value });
    if (id === 'note')
      assert.ok(
        await read(
          `(()=>{const e=document.querySelector('.text-editor');return e.scrollHeight<=e.clientHeight+1;})()`,
        ),
        'note overflows while typing',
      );
    await key('Enter', 'Enter', 2);
    await until(
      async () => (await documentState()).objects.find((o) => o.id === id).text === value,
      id + ' persisted',
    );
  }
  // Alignment toggles are independent, work during editing and persist on save.
  await click(host.x + 90, host.y + 215);
  await click(host.x + 90, host.y + 215);
  await until(() => rect('.text-editor'), 'note alignment editor');
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Centered\nBoth ways' });
  await clickSelector('[aria-label="Center horizontally"]');
  assert.equal(
    await read(
      `document.querySelector('[aria-label="Center horizontally"]').getAttribute('aria-pressed')`,
    ),
    'true',
  );
  assert.equal(
    await read(
      `document.querySelector('[aria-label="Center vertically"]').getAttribute('aria-pressed')`,
    ),
    'false',
  );
  await clickSelector('[aria-label="Center vertically"]');
  const centeredEditor = await rect('.text-editor');
  assert.ok(
    Math.abs(centeredEditor.y + centeredEditor.height / 2 - (host.y + 190 + 120)) < 2,
    'editor not vertically centered',
  );
  assert.ok(
    Math.abs(centeredEditor.x + centeredEditor.width / 2 - (host.x + 60 + 130)) < 2,
    'editor not horizontally centered',
  );
  assert.equal(
    await read(`getComputedStyle(document.querySelector('.text-editor')).textAlign`),
    'center',
  );
  assert.equal(
    await read(`document.activeElement===document.querySelector('.text-editor')`),
    true,
    'centering lost caret',
  );
  await click(host.x + 1050, host.y + 180);
  await until(async () => {
    const o = (await documentState()).objects.find((o) => o.id === 'note');
    return o.centerX && o.centerY;
  }, 'alignment saved');
  await sleep(150);
  const alignedShot = await send('Page.captureScreenshot', { format: 'png' });
  const shotBuffer = Buffer.from(alignedShot.data, 'base64');
  writeFileSync(join(root, 'centered-note.png'), shotBuffer);
  const meta = await sharp(shotBuffer).metadata();
  const pixelScale = meta.width / (await read('window.innerWidth'));
  const area = {
    left: Math.round((host.x + 68) * pixelScale),
    top: Math.round((host.y + 198) * pixelScale),
    width: Math.round(244 * pixelScale),
    height: Math.round(224 * pixelScale),
  };
  const { data: ink, info } = await sharp(shotBuffer)
    .extract(area)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let minX = info.width,
    minY = info.height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (ink[i] < 130 && ink[i + 1] < 140 && ink[i + 2] < 150) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  assert.ok(maxX > minX && maxY > minY, 'centered text did not render');
  assert.ok(
    Math.abs((minX + maxX) / 2 - info.width / 2) < 12 * pixelScale,
    'rendered ink not horizontally centered',
  );
  assert.ok(
    Math.abs((minY + maxY) / 2 - info.height / 2) < 12 * pixelScale,
    'rendered ink not vertically centered',
  );
  await key('z', 'KeyZ', 2);
  await until(
    async () => !(await documentState()).objects.find((o) => o.id === 'note').centerY,
    'alignment undo',
  );
  await key('z', 'KeyZ', 10);
  await until(
    async () => !!(await documentState()).objects.find((o) => o.id === 'note').centerY,
    'alignment redo',
  );
  await click(host.x + 90, host.y + 215);
  await clickSelector('[aria-label="Center horizontally"]');
  await until(async () => {
    const o = (await documentState()).objects.find((o) => o.id === 'note');
    return o.centerX === false && o.centerY === true;
  }, 'horizontal toggled off independently');
  await sleep(100);
  const leftShot = await send('Page.captureScreenshot', { format: 'png' });
  const leftPixels = await sharp(Buffer.from(leftShot.data, 'base64'))
    .extract(area)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let leftMin = leftPixels.info.width,
    leftMax = -1;
  for (let y = 0; y < leftPixels.info.height; y++)
    for (let x = 0; x < leftPixels.info.width; x++) {
      const i = (y * leftPixels.info.width + x) * leftPixels.info.channels;
      if (
        leftPixels.data[i] < 130 &&
        leftPixels.data[i + 1] < 140 &&
        leftPixels.data[i + 2] < 150
      ) {
        leftMin = Math.min(leftMin, x);
        leftMax = Math.max(leftMax, x);
      }
    }
  assert.ok(
    (leftMin + leftMax) / 2 < (minX + maxX) / 2 - 20 * pixelScale,
    'toolbar toggle outside editor did not redraw text',
  );
  await clickSelector('[aria-label="Center horizontally"]');
  // Add the shape to the note selection using Shift, then align both together.
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', {
      type,
      x: host.x + 430,
      y: host.y + 365,
      button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1,
      modifiers: 8,
    });
  assert.ok(await rect('[aria-label="Group selection"]'), 'alignment multi-selection missing');
  await clickSelector('[aria-label="Center horizontally"]');
  await clickSelector('[aria-label="Center vertically"]');
  await until(
    async () =>
      (await documentState()).objects
        .filter((o) => ['note', 'shape'].includes(o.id))
        .every((o) => o.centerX && o.centerY),
    'multi-selection centered',
  );
  await doubleClick(host.x + 90, host.y + 215);
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: '🌍 中文 café فكرة '.repeat(45) });
  await sleep(100);
  assert.ok(
    await read(
      `(()=>{const e=document.querySelector('.text-editor');return e.scrollHeight<=e.clientHeight+1;})()`,
    ),
    'centered mixed-script note clips text',
  );
  await key('Escape', 'Escape');
  await click(host.x + 1050, host.y + 180);
  await click(host.x + 430, host.y + 51);
  await until(
    () => read(`document.querySelector('.text-editor')?.value==='Edited frame'`),
    'one click on the outside frame name opens its editor',
  );
  const frameEditor = await rect('.text-editor');
  assert.ok(frameEditor.y + frameEditor.height < host.y + 70, 'name editor is above frame');
  assert.ok(Math.abs(frameEditor.x - (host.x + 390)) < 1, 'name starts at frame left edge');
  assert.equal(await read(`!document.querySelector('[aria-label="Center vertically"]')`), true);
  await send('Input.insertText', { text: ' renamed' });
  await key('Enter', 'Enter');
  await until(
    async () =>
      (await documentState()).objects.find((o) => o.id === 'frame').text === 'Edited frame renamed',
    'frame name saved with Enter',
  );
  const frameShot = await send('Page.captureScreenshot', { format: 'png' });
  const frameBuffer = Buffer.from(frameShot.data, 'base64');
  writeFileSync(join(root, 'white-frame.png'), frameBuffer);
  const framePixels = await sharp(frameBuffer)
    .extract({
      left: Math.round((host.x + 580) * pixelScale),
      top: Math.round((host.y + 210) * pixelScale),
      width: 10,
      height: 10,
    })
    .removeAlpha()
    .raw()
    .toBuffer();
  assert.ok(
    framePixels.every((value) => value === 255),
    'frame surface is solid pure white without grid dots',
  );
  // Keep controls next to a low-on-board selection, including during real drags.
  const textObject = async () => (await documentState()).objects.find((o) => o.id === 'text');
  const originalText = await textObject();
  await click(host.x + originalText.x + 30, host.y + originalText.y + 20);
  const drag = async (from, to, during) => {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x,
      y: from.y,
      buttons: 0,
    });
    await sleep(50);
    await mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= 12; i++) {
      await mouse(
        'mouseMoved',
        from.x + ((to.x - from.x) * i) / 12,
        from.y + ((to.y - from.y) * i) / 12,
      );
      await sleep(15);
    }
    if (during) await during();
    await mouse('mouseReleased', to.x, to.y);
  };
  // Put an existing object inside the frame, then move the frame with real input.
  const frameState = async () => (await documentState()).objects;
  const shapeBefore = (await frameState()).find((o) => o.id === 'shape');
  await drag(
    { x: host.x + shapeBefore.x + 40, y: host.y + shapeBefore.y + 40 },
    { x: host.x + shapeBefore.x + 40, y: host.y + 160 },
  );
  await until(
    async () => (await frameState()).find((o) => o.id === 'shape').y === 120,
    'shape placed in frame',
  );
  await drag({ x: host.x + 660, y: host.y + 295 }, { x: host.x + 740, y: host.y + 315 });
  await until(async () => {
    const objects = await frameState();
    return (
      objects.find((o) => o.id === 'frame').x === 470 &&
      objects.find((o) => o.id === 'shape').x === shapeBefore.x + 80 &&
      objects.find((o) => o.id === 'shape').y === 140
    );
  }, 'frame carries contents and saves their positions');
  await key('z', 'KeyZ', 2);
  await until(
    async () => (await frameState()).find((o) => o.id === 'shape').y === 120,
    'frame and contents undo together',
  );
  await key('z', 'KeyZ', 2);
  await until(
    async () => (await frameState()).find((o) => o.id === 'shape').y === shapeBefore.y,
    'restore shape placement',
  );
  await click(host.x + 1000, host.y + 650);
  await key('a', 'KeyA', 2);
  {
    const beforeScale = await frameState();
    const left = Math.min(...beforeScale.map((o) => o.x)),
      top = Math.min(...beforeScale.map((o) => o.y));
    const right = Math.max(...beforeScale.map((o) => o.x + o.width)),
      bottom = Math.max(...beforeScale.map((o) => o.y + o.height));
    const selectionShot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(
      join(root, 'selection-scale-handles.png'),
      Buffer.from(selectionShot.data, 'base64'),
    );
    await drag(
      { x: host.x + left, y: host.y + top },
      { x: host.x + left + (right - left) * 0.1, y: host.y + top + (bottom - top) * 0.1 },
    );
    await until(async () => {
      const after = await frameState();
      return beforeScale.every((o) => {
        const n = after.find((item) => item.id === o.id);
        return (
          Math.abs(n.width / o.width - 0.9) < 0.005 && Math.abs(n.height / o.height - 0.9) < 0.005
        );
      });
    }, 'whole selection scales proportionally');
    await key('z', 'KeyZ', 2);
    await until(async () => {
      const after = await frameState();
      return beforeScale.every((o) => {
        const n = after.find((item) => item.id === o.id);
        return n.x === o.x && n.y === o.y && n.width === o.width && n.height === o.height;
      });
    }, 'whole selection restored with one undo');
  }
  await key('Escape', 'Escape');
  await click(host.x + originalText.x + 30, host.y + originalText.y + 20);
  const checkToolbar = async (o, camera = { x: 0, y: 0, zoom: 1 }) => {
    await sleep(100);
    const toolbar = await rect('.selection-tools');
    assert.ok(toolbar, 'selection toolbar missing');
    const top = host.y + o.y * camera.zoom + camera.y;
    const gap = top - toolbar.y - toolbar.height;
    assert.ok(Math.abs(gap - 14) < 2, `toolbar not beside object: gap ${gap}`);
    assert.ok(
      toolbar.x >= host.x && toolbar.x + toolbar.width <= host.x + host.width + 1,
      'toolbar outside viewport',
    );
    return toolbar;
  };
  const fromText = { x: host.x + originalText.x + 30, y: host.y + originalText.y + 20 };
  const movedText = { ...originalText, x: originalText.x + 100, y: originalText.y + 340 };
  await drag(fromText, { x: fromText.x + 100, y: fromText.y + 340 }, () => checkToolbar(movedText));
  await until(async () => Math.abs((await textObject()).y - movedText.y) < 0.01, 'text moved');
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const o = await textObject();
    const west = corner.includes('w'),
      north = corner.includes('n');
    const from = {
      x: host.x + o.x + (west ? 0 : o.width),
      y: host.y + o.y + (north ? 0 : o.height),
    };
    const scale = 1.2;
    const to = {
      x: from.x + (west ? -1 : 1) * o.width * (scale - 1),
      y: from.y + (north ? -1 : 1) * o.height * (scale - 1),
    };
    await drag(from, to);
    const resized = await until(async () => {
      const next = await textObject();
      return next.fontSize !== o.fontSize ? next : null;
    }, `${corner} font scaled`);
    assert.ok(Math.abs(resized.fontSize / o.fontSize - scale) < 0.01, `${corner} wrong font scale`);
    assert.ok(
      Math.abs(resized.width / o.width - resized.height / o.height) < 0.001,
      `${corner} distorted text`,
    );
    assert.ok(
      Math.abs(resized.x + (west ? resized.width : 0) - (o.x + (west ? o.width : 0))) < 0.01,
      `${corner} opposite x moved`,
    );
    assert.ok(
      Math.abs(resized.y + (north ? resized.height : 0) - (o.y + (north ? o.height : 0))) < 0.01,
      `${corner} opposite y moved`,
    );
    await checkToolbar(resized);
    if (corner === 'se') {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(root, 'text-controls.png'), Buffer.from(shot.data, 'base64'));
    }
    await key('z', 'KeyZ', 2);
    await until(async () => (await textObject()).fontSize === o.fontSize, `${corner} undo`);
  }
  const panFrom = { x: host.x + 650, y: host.y + 560 };
  await mouse('mousePressed', panFrom.x, panFrom.y, 'right');
  await mouse('mouseMoved', panFrom.x + 20, panFrom.y - 30, 'right');
  await checkToolbar(movedText, { x: 20, y: -30, zoom: 1 });
  await mouse('mouseReleased', panFrom.x + 20, panFrom.y - 30, 'right');
  await mouse('mousePressed', panFrom.x + 20, panFrom.y - 30, 'right');
  await mouse('mouseMoved', panFrom.x, panFrom.y, 'right');
  await mouse('mouseReleased', panFrom.x, panFrom.y, 'right');
  await read(
    `(()=>{window.zoomFrames=[];const start=performance.now();function sample(){const e=document.querySelector('.canvas-surface');window.zoomFrames.push({time:performance.now()-start,zoom:parseFloat(e.style.backgroundSize)/24});if(performance.now()-start<650)requestAnimationFrame(sample)}requestAnimationFrame(sample)})()`,
  );
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: panFrom.x,
    y: panFrom.y,
    deltaX: 0,
    deltaY: -80,
  });
  const zoomedCamera = await until(async () => {
    const c = (await documentState()).camera;
    return c.zoom > 1.07 ? c : null;
  }, 'zoom saved');
  const zoomFrames = await read('window.zoomFrames');
  const intermediate = zoomFrames.filter((f) => f.zoom > 1.001 && f.zoom < Math.exp(0.08) - 0.001);
  assert.ok(
    new Set(intermediate.map((f) => f.zoom.toFixed(4))).size >= 3,
    'wheel must animate through intermediate scales',
  );
  assert.ok(Math.abs(zoomedCamera.zoom - Math.exp(0.08)) < 0.0001, 'gentler wheel endpoint');
  assert.ok(Math.abs(650 * zoomedCamera.zoom + zoomedCamera.x - 650) < 0.001, 'wheel anchor x');
  assert.ok(Math.abs(560 * zoomedCamera.zoom + zoomedCamera.y - 560) < 0.001, 'wheel anchor y');
  writeFileSync(join(root, 'wheel-animation.json'), JSON.stringify(zoomFrames, null, 2));
  await checkToolbar(movedText, zoomedCamera);
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: panFrom.x,
    y: panFrom.y,
    deltaX: 0,
    deltaY: 80,
  });
  await until(
    async () => Math.abs((await documentState()).camera.zoom - 1) < 0.001,
    'zoom restored',
  );
  await key('z', 'KeyZ', 2);
  await until(async () => (await textObject()).y === originalText.y, 'move undo');
  await doubleClick(host.x + originalText.x + 20, host.y + originalText.y + 20);
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Flightline' });
  await sleep(100);
  const tight = await rect('.text-editor');
  const inkWidth = await read(
    `(()=>{const e=document.querySelector('.text-editor'),c=document.createElement('canvas').getContext('2d');c.font=getComputedStyle(e).font;return c.measureText(e.value).width;})()`,
  );
  assert.ok(
    tight.width >= inkWidth && tight.width < inkWidth + 10,
    'plain text editor retains oversized width',
  );
  await key('a', 'KeyA', 2);
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'A much longer first line\nSecond line\nThird line' });
  await sleep(100);
  const expanded = await rect('.text-editor');
  assert.ok(
    expanded.width > tight.width * 1.5 && expanded.height > tight.height * 2,
    'text box did not grow with content',
  );
  await key('a', 'KeyA', 2);
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Flightline' });
  await clickSelector('.selection-tools [aria-label="Set color #e4ecfa"]');
  assert.equal(
    await read(`getComputedStyle(document.querySelector('.text-editor')).color`),
    'rgb(228, 236, 250)',
    'color toolbar did not update live text',
  );
  assert.equal(
    await read(`document.activeElement===document.querySelector('.text-editor')`),
    true,
    'toolbar click interrupted editing',
  );
  assert.equal(
    await read(`document.querySelector('.text-editor').value`),
    'Flightline',
    'toolbar lost draft',
  );
  await sleep(100);
  const compact = await rect('.text-editor');
  assert.ok(
    Math.abs(compact.width - tight.width) < 1 && Math.abs(compact.height - tight.height) < 1,
    'box did not shrink after deleting content',
  );
  const editShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, 'editing-controls.png'), Buffer.from(editShot.data, 'base64'));
  await click(host.x + 1050, host.y + 180);
  const fittedText = await until(async () => {
    const o = await textObject();
    return o.text === 'Flightline' && o.color === '#e4ecfa' ? o : null;
  }, 'fitted text and color saved on blur');
  assert.ok(
    fittedText.width < inkWidth + 25 && fittedText.height < 60,
    'saved selection bounds are oversized',
  );
  await doubleClick(host.x + fittedText.x + 20, host.y + fittedText.y + 20);
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Uncommitted draft' });
  await key('Tab', 'Tab', 8);
  assert.equal(
    await read(`document.activeElement.getAttribute('aria-label')`),
    'Delete selection',
    'keyboard did not reach toolbar',
  );
  await key('Delete', 'Delete');
  assert.ok(
    await read(`!!document.querySelector('.text-editor')`),
    'toolbar key discarded the editor',
  );
  await key('Escape', 'Escape');
  await sleep(400);
  assert.equal(
    (await textObject()).text,
    'Flightline',
    'toolbar keyboard shortcuts changed the board or restored a deleted draft',
  );
  await doubleClick(host.x + fittedText.x + 20, host.y + fittedText.y + 20);
  const editCorner = {
    x: host.x + fittedText.x + fittedText.width,
    y: host.y + fittedText.y + fittedText.height,
  };
  await drag(editCorner, {
    x: editCorner.x + fittedText.width * 0.2,
    y: editCorner.y + fittedText.height * 0.2,
  });
  await until(
    async () => (await textObject()).fontSize > fittedText.fontSize,
    'corner resize while editing',
  );
  await key('z', 'KeyZ', 2);
  await until(
    async () => (await textObject()).fontSize === fittedText.fontSize,
    'editing corner resize undo',
  );
  await doubleClick(host.x + fittedText.x + 20, host.y + fittedText.y + 20);
  await key('a', 'KeyA', 2);
  await key('Backspace', 'Backspace');
  await click(host.x + 1050, host.y + 180);
  await until(async () => !(await textObject()), 'empty text removed on blur');
  await key('z', 'KeyZ', 2);
  await until(async () => (await textObject())?.text === 'Flightline', 'empty text deletion undo');
  await doubleClick(host.x + fittedText.x + 20, host.y + fittedText.y + 20);
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Current draft' });
  await clickSelector('.selection-tools [aria-label="Duplicate selection"]');
  const duplicate = await until(
    async () =>
      (await documentState()).objects.find(
        (o) => o.type === 'text' && o.id !== 'text' && o.text === 'Current draft',
      ),
    'duplicate uses active draft',
  );
  await clickSelector('.selection-tools [aria-label="Delete selection"]');
  await until(
    async () => !(await documentState()).objects.some((o) => o.id === duplicate.id),
    'duplicate cleaned up',
  );
  // At high zoom a tall editor covers the viewport; controls must stay above it.
  await doubleClick(host.x + fittedText.x + 20, host.y + fittedText.y + 20);
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Tall editable text across the board\n'.repeat(30) });
  await sleep(100);
  for (let i = 0; i < 12; i++)
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: host.x + 30,
      y: host.y + 300,
      deltaX: 0,
      deltaY: -100,
    });
  await until(async () => (await documentState()).camera.zoom > 3, 'tall editor zoom');
  await sleep(100);
  assert.equal(
    await read(
      `(()=>{const b=document.querySelector('.selection-tools [aria-label="Set color #e4eee8"]'),r=b.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b;})()`,
    ),
    true,
    'tall editor covers toolbar',
  );
  await clickSelector('.selection-tools [aria-label="Set color #e4eee8"]');
  assert.equal(
    await read(`getComputedStyle(document.querySelector('.text-editor')).color`),
    'rgb(228, 238, 232)',
    'tall editor toolbar cannot be clicked',
  );
  await key('Escape', 'Escape');
  for (let i = 0; i < 12; i++)
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: host.x + 30,
      y: host.y + 300,
      deltaX: 0,
      deltaY: 100,
    });
  await until(
    async () => Math.abs((await documentState()).camera.zoom - 1) < 0.001,
    'tall editor zoom restored',
  );
  const beforeBlank = (await documentState()).objects.length;
  await doubleClick(host.x + 1050, host.y + 180);
  await until(() => rect('.text-editor'), 'new empty text editor');
  await click(host.x + 1100, host.y + 240);
  await until(
    async () => (await documentState()).objects.length === beforeBlank,
    'new blank text discarded on blur',
  );
  // Exercise transform handles through the packaged window's trusted input path.
  const object = async (id) => (await documentState()).objects.find((o) => o.id === id);
  const point = (o, u, v, extra = 0) => {
    const a = ((o.rotation || 0) * Math.PI) / 180;
    const x = (u - 0.5) * o.width,
      y = (v - 0.5) * o.height + extra;
    return {
      x: host.x + o.x + o.width / 2 + x * Math.cos(a) - y * Math.sin(a),
      y: host.y + o.y + o.height / 2 + x * Math.sin(a) + y * Math.cos(a),
    };
  };
  let transformText = await object('text');
  let p = point(transformText, 0, 0);
  await doubleClick(p.x + 20, p.y + 20);
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Rotate me' });
  await key('Enter', 'Enter', 2);
  transformText = await until(async () => {
    const o = await object('text');
    return o.text === 'Rotate me' ? o : null;
  }, 'transform text prepared');
  p = point(transformText, 0.5, 0.5);
  await drag(p, { x: host.x + 530, y: host.y + 540 });
  await until(
    async () => Math.abs((await object('text')).y + (await object('text')).height / 2 - 540) < 0.1,
    'transform text moved',
  );
  for (const id of ['text', 'note']) {
    let o = await object(id);
    p = point(o, 0.5, 0.5);
    await click(host.x + 1100, host.y + 180);
    await click(p.x, p.y);
    for (const [edge, u, v, dx, dy] of [
      ['n', 0.5, 0, 0, -30],
      ['e', 1, 0.5, 30, 0],
      ['s', 0.5, 1, 0, 30],
      ['w', 0, 0.5, -30, 0],
    ]) {
      o = await object(id);
      const from = point(o, u, v),
        anchor = point(o, 1 - u, 1 - v);
      await drag(from, { x: from.x + dx, y: from.y + dy });
      const changed = await until(async () => {
        const n = await object(id);
        return Math.abs(n.width - o.width) + Math.abs(n.height - o.height) > 20 ? n : null;
      }, `${id} ${edge} edge resized`);
      assert.equal(changed.fontSize, o.fontSize, 'edge changed base font size');
      assert.ok(
        Math.abs(changed.width - o.width - (dx ? 30 : 0)) < 0.01 &&
          Math.abs(changed.height - o.height - (dy ? 30 : 0)) < 0.01,
        'edge changed wrong dimension',
      );
      const fixed = point(changed, 1 - u, 1 - v);
      assert.ok(Math.hypot(fixed.x - anchor.x, fixed.y - anchor.y) < 0.01, 'opposite edge moved');
      await key('z', 'KeyZ', 2);
      await until(
        async () =>
          Math.abs((await object(id)).width - o.width) +
            Math.abs((await object(id)).height - o.height) <
          0.01,
        'edge undo',
      );
    }
  }
  // Rotate the note, verify the angle badge, then resize in its local axes.
  let noteBefore = await object('note');
  p = point(noteBefore, 0.5, 0.5);
  const rotateHandle = (o) => point(o, -28 / o.width, 1, 28);
  const knob = rotateHandle(noteBefore);
  await drag(knob, rotateHandle({ ...noteBefore, rotation: 90 }), async () => {
    assert.equal(
      await read(`document.querySelector('.rotation-angle').hidden`),
      false,
      'rotation angle hidden during drag',
    );
    assert.ok(
      (await read(`document.querySelector('.rotation-angle').textContent`)).includes('90'),
      'live angle incorrect',
    );
  });
  let rotatedNote = await until(async () => {
    const o = await object('note');
    return Math.abs(o.rotation - 90) < 0.1 ? o : null;
  }, 'note rotation');
  const east = point(rotatedNote, 1, 0.5),
    west = point(rotatedNote, 0, 0.5);
  await drag(east, { x: east.x, y: east.y + 30 });
  let widerNote = await until(async () => {
    const o = await object('note');
    return o.width > rotatedNote.width + 20 ? o : null;
  }, 'rotated edge resize');
  const fixedWest = point(widerNote, 0, 0.5);
  assert.ok(
    Math.hypot(fixedWest.x - west.x, fixedWest.y - west.y) < 0.01,
    'rotated opposite edge moved',
  );
  await key('z', 'KeyZ', 2);
  await until(
    async () => Math.abs((await object('note')).width - noteBefore.width) < 0.01,
    'rotated resize undo',
  );
  await key('z', 'KeyZ', 2);
  await until(async () => !(await object('note')).rotation, 'rotation undo');
  // A manual text box keeps its size through editing and a 180-degree rotation.
  transformText = await object('text');
  p = point(transformText, 0.5, 0.5);
  await click(p.x, p.y);
  const textEast = point(transformText, 1, 0.5);
  await drag(textEast, { x: textEast.x + 70, y: textEast.y });
  transformText = await until(async () => {
    const o = await object('text');
    return o.textBox ? o : null;
  }, 'manual text box');
  p = point(transformText, 0.5, 0.5);
  const bottom = rotateHandle(transformText),
    above = rotateHandle({ ...transformText, rotation: 180 });
  await drag(bottom, above);
  transformText = await until(async () => {
    const o = await object('text');
    return Math.abs(o.rotation - 180) < 0.1 ? o : null;
  }, 'text rotation 180');
  await sleep(100);
  const tools = await rect('.selection-tools');
  assert.ok(tools.y + tools.height < above.y - 5, 'toolbar covers rotated handle');
  // Regrab the now upper handle and cancel without changing saved geometry.
  await mouse('mousePressed', above.x, above.y);
  await mouse('mouseMoved', above.x + 25, above.y + 20);
  await key('Escape', 'Escape');
  await mouse('mouseReleased', above.x + 25, above.y + 20);
  assert.ok(
    Math.abs((await object('text')).rotation - 180) < 0.1,
    'Escape did not cancel rotation',
  );
  p = point(transformText, 0.5, 0.5);
  await click(p.x, p.y);
  await until(() => rect('.text-editor'), 'rotated editor');
  assert.ok(
    await read(
      `getComputedStyle(document.querySelector('.text-editor')).transform.startsWith('matrix(-1')`,
    ),
    'editor not rotated',
  );
  await key('a', 'KeyA', 2);
  await send('Input.insertText', {
    text: 'Wrapped words that should stay inside this deliberately short manual text box. '.repeat(
      5,
    ),
  });
  await clickSelector('[aria-label="Center vertically"]');
  assert.ok(
    await read(
      `(()=>{const e=document.querySelector('.text-editor');return e.clientHeight<${transformText.height};})()`,
    ),
    'centered manual editor overflows box',
  );
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Rotated text' });
  await key('Enter', 'Enter', 2);
  await until(async () => (await object('text')).text === 'Rotated text', 'rotated edit saved');
  assert.equal((await object('text')).width, transformText.width, 'editing reset manual width');
  const transformShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, 'transform-controls.png'), Buffer.from(transformShot.data, 'base64'));
  // Draw and reshape an arrow using actual pointer input.
  await clickSelector('[aria-label="Arrow"]');
  await drag({ x: host.x + 80, y: host.y + 540 }, { x: host.x + 620, y: host.y + 540 });
  const arrow = await until(
    async () => (await documentState()).objects.find((o) => o.type === 'arrow'),
    'arrow saved',
  );
  await drag({ x: host.x + 350, y: host.y + 540 }, { x: host.x + 350, y: host.y + 640 });
  await until(
    async () => (await object(arrow.id)).arrow.points.length === 3,
    'bend inserted by dragging midpoint',
  );
  await key('z', 'KeyZ', 2);
  await until(async () => (await object(arrow.id)).arrow.points.length === 2, 'bend undo');
  await key('z', 'KeyZ', 10);
  await until(async () => (await object(arrow.id)).arrow.points.length === 3, 'bend redo');
  await clickSelector('[aria-label="Line style"]');
  assert.equal(
    await read(`document.querySelector('.arrow-style-popover').querySelectorAll('select').length`),
    0,
    'style choices must be visible without nested menus',
  );
  for (const line of ['straight', 'elbow', 'curve']) {
    await clickSelector(`[aria-label="Arrow path ${line}"]`);
    await until(async () => (await object(arrow.id)).arrow.line === line, 'arrow path ' + line);
  }
  for (const dash of ['dotted', 'solid', 'dashed']) {
    await clickSelector(`[aria-label="Arrow stroke ${dash}"]`);
    await until(async () => (await object(arrow.id)).arrow.dash === dash, 'arrow stroke ' + dash);
  }
  const slider = await rect('[aria-label="Arrow thickness"]');
  await drag(
    { x: slider.x + 8 + ((slider.width - 16) * 2.5) / 39.5, y: slider.y + slider.height / 2 },
    { x: slider.x + 8 + ((slider.width - 16) * 10) / 39.5, y: slider.y + slider.height / 2 },
  );
  const thickness = await until(async () => {
    const n = (await object(arrow.id)).arrow.thickness;
    return n > 8 && n < 13 ? n : false;
  }, 'live thickness slider saved');
  await clickSelector('[aria-label="Line style"]');
  await key('z', 'KeyZ', 2);
  await until(
    async () => (await object(arrow.id)).arrow.thickness === 3,
    'slider drag undoes in one step',
  );
  await key('z', 'KeyZ', 10);
  await until(async () => (await object(arrow.id)).arrow.thickness === thickness, 'slider redo');
  await clickSelector('[aria-label="Line style"]');
  writeFileSync(
    join(root, 'arrow-style-previews.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await clickSelector('[aria-label="Line style"]');
  await clickSelector('[aria-label="Start arrowhead"]');
  await clickSelector('[aria-label="start Diamond"]');
  await clickSelector('[aria-label="End arrowhead"]');
  writeFileSync(
    join(root, 'arrow-head-previews.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await clickSelector('[aria-label="end Triangle"]');
  await clickSelector('[aria-label="Swap arrowheads"]');
  await until(async () => (await object(arrow.id)).arrow.start === 'triangle', 'swapped markers');
  await clickSelector('[aria-label="Arrow label"]');
  await send('Input.insertText', { text: 'Editable connection' });
  await key('Enter', 'Enter');
  await until(
    async () => (await object(arrow.id)).text === 'Editable connection',
    'arrow label saved',
  );
  // Font size uses a live range control with one history entry per drag.
  await clickSelector('[aria-label="Arrow label"]');
  const fontSlider = await rect('[aria-label="Arrow label size"]');
  assert.equal(
    await read(`document.querySelector('[aria-label="Arrow label size"]').type`),
    'range',
  );
  const sliderX = (value) => fontSlider.x + 8 + ((fontSlider.width - 16) * (value - 8)) / 292;
  const sliderY = fontSlider.y + fontSlider.height / 2;
  await mouse('mousePressed', sliderX(18), sliderY);
  for (const size of [28, 40, 54]) {
    await mouse('mouseMoved', sliderX(size), sliderY);
    await sleep(60);
  }
  const labelSize = await until(async () => {
    const size = (await object(arrow.id)).fontSize;
    return size >= 50 && size <= 58 ? size : false;
  }, 'label size updates before releasing slider');
  await mouse('mouseReleased', sliderX(54), sliderY);
  writeFileSync(
    join(root, 'arrow-font-slider.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await clickSelector('[aria-label="Arrow label"]');
  await key('z', 'KeyZ', 2);
  await until(async () => (await object(arrow.id)).fontSize === 18, 'font slider single-step undo');
  await key('z', 'KeyZ', 10);
  await until(async () => (await object(arrow.id)).fontSize === labelSize, 'font slider redo');
  assert.equal((await object(arrow.id)).text, 'Editable connection', 'font change preserved label');
  await clickSelector('[aria-label="Arrow label"]');
  await send('Input.insertText', { text: 'discard this' });
  await key('Escape', 'Escape');
  assert.equal(
    (await object(arrow.id)).text,
    'Editable connection',
    'Escape cancelled label draft',
  );
  await doubleClick(host.x + 350, host.y + 640);
  await until(
    async () => (await object(arrow.id)).arrow.points.length === 2,
    'double click removes bend',
  );
  await key('z', 'KeyZ', 2);
  await until(async () => (await object(arrow.id)).arrow.points.length === 3, 'remove bend undo');
  await drag({ x: host.x + 620, y: host.y + 540 }, { x: host.x + 660, y: host.y + 500 });
  await until(
    async () => Math.abs((await object(arrow.id)).width - 580) < 0.001,
    'endpoint repositioned',
  );
  await key('z', 'KeyZ', 2);
  await until(async () => Math.abs((await object(arrow.id)).width - 540) < 0.001, 'endpoint undo');
  writeFileSync(
    join(root, 'arrow-controls.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await click(host.x + 1100, host.y + 650);
  const title = await rect('.board-title');
  await click(title.x + title.width / 2, title.y + title.height / 2, 'right');
  const renameTitle = await read(`(() => {
    const e = [...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent.trim() === 'Rename');
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await click(renameTitle.x, renameTitle.y);
  await sleep(100);
  assert.equal(
    await read(`document.querySelector('.board-title').isContentEditable`),
    true,
    'board name context-menu rename failed',
  );
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Renamed with one click' });
  await key('Enter', 'Enter');
  await until(
    async () => (await documentState()).board.name === 'Renamed with one click',
    'board name saved',
  );
  await click(host.x + 900, host.y + 460, 'right');
  await until(
    () =>
      read(
        `[...document.querySelectorAll('[role="menuitem"]')].some(e=>e.textContent==='Crop image')`,
      ),
    'Crop image in right-click menu',
  );
  const menu = await read(
    `(()=>{const e=[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent==='Crop image');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  await click(menu.x, menu.y);
  await until(() => rect('.crop-window'), 'crop overlay');
  const handle = await rect('[data-edge="w"]'),
    crop = await rect('.crop-window');
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 },
    to = { x: crop.x + crop.width / 2, y: from.y };
  await mouse('mousePressed', from.x, from.y);
  for (let i = 1; i <= 12; i++) {
    await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / 12, from.y);
    await sleep(15);
  }
  await mouse('mouseReleased', to.x, to.y);
  await sleep(100);
  const resized = await rect('.crop-window');
  assert.ok(resized.width < crop.width * 0.6, 'real pointer drag did not resize crop');
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, 'crop-controls.png'), Buffer.from(screenshot.data, 'base64'));
  await clickSelector('.crop-toolbar .primary');
  const saved = await until(async () => {
    const o = (await documentState()).objects.find((o) => o.id === 'image');
    return o.crop ? o : null;
  }, 'crop persisted');
  assert.ok(saved.crop.x > 0.45 && saved.crop.x < 0.55 && saved.width < 260, 'saved wrong crop');
  await key('z', 'KeyZ', 2);
  await until(
    async () => !(await documentState()).objects.find((o) => o.id === 'image').crop,
    'crop undo',
  );
  await key('z', 'KeyZ', 10);
  await until(
    async () => !!(await documentState()).objects.find((o) => o.id === 'image').crop,
    'crop redo',
  );
  // Cropping follows the image's local axes after rotation.
  const imageBefore = await object('image');
  const imageCenter = point(imageBefore, 0.5, 0.5);
  const imageKnob = rotateHandle(imageBefore);
  await drag(imageKnob, rotateHandle({ ...imageBefore, rotation: 90 }));
  await until(async () => Math.abs((await object('image')).rotation - 90) < 0.1, 'image rotated');
  await click(imageCenter.x, imageCenter.y, 'right');
  const rotatedCropMenu = await until(
    () =>
      read(
        `(()=>{const e=[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent==='Crop image');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
      ),
    'rotated crop menu',
  );
  await click(rotatedCropMenu.x, rotatedCropMenu.y);
  await until(() => rect('.crop-window'), 'rotated crop overlay');
  assert.ok(
    await read(
      `(()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('.crop-window')).transform);return Math.abs(m.a)<.001 && Math.abs(m.b-1)<.001;})()`,
    ),
    'crop overlay not rotated',
  );
  const northCrop = await rect('[data-edge="n"]');
  const northPoint = {
    x: northCrop.x + northCrop.width / 2,
    y: northCrop.y + northCrop.height / 2,
  };
  await drag(northPoint, { x: northPoint.x - 40, y: northPoint.y });
  const rotatedCropShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, 'rotated-crop.png'), Buffer.from(rotatedCropShot.data, 'base64'));
  await clickSelector('.crop-toolbar .primary');
  await until(async () => {
    const o = await object('image');
    return o.crop.height < imageBefore.crop.height - 0.05 && Math.abs(o.rotation - 90) < 0.1;
  }, 'rotated crop saved');
  // The active title draft must survive an actual desktop close request.
  const name = await rect('.board-title');
  await click(name.x + name.width / 2, name.y + name.height / 2, 'right');
  const renameDraft = await read(`(() => {
    const e = [...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent.trim() === 'Rename');
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  await click(renameDraft.x, renameDraft.y);
  await until(
    () => read(`document.querySelector('.board-title').isContentEditable`),
    'active title editor ready',
  );
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Active title saved on close' });
  assert.equal(
    await read(`document.querySelector('.board-title').textContent`),
    'Active title saved on close',
    'final name draft was not entered',
  );
  assert.deepEqual(errors, [], 'renderer raised errors');
  const inputLog = await read('window.inputLog');
  assert.ok(
    inputLog.every((e) => e.trusted),
    'untrusted synthetic click used',
  );
  await closeWindow();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('App did not close gracefully')), 10000);
    exited.then((code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const reopened = new Store(root);
  const result = reopened.loadBoard({ id: board.id });
  reopened.close();
  assert.equal(result.board.name, 'Active title saved on close');
  assert.ok(result.objects.find((o) => o.id === 'image').crop);
  assert.equal(result.objects.find((o) => o.id === arrow.id).text, 'Editable connection');
  assert.equal(result.objects.find((o) => o.id === arrow.id).arrow.points.length, 3);
  assert.ok(Math.abs(result.objects.find((o) => o.id === 'image').rotation - 90) < 0.1);
  assert.ok(result.objects.find((o) => o.id === 'text').textBox);
  assert.ok(Math.abs(result.objects.find((o) => o.id === 'text').rotation - 180) < 0.1);
  assert.ok(
    result.objects
      .filter((o) => ['note', 'shape'].includes(o.id))
      .every((o) => o.centerX && o.centerY),
    'alignment lost on reopen',
  );
  console.log(
    JSON.stringify(
      {
        executable,
        library: root,
        doubleClicks: inputLog,
        edited: ['text', 'note', 'frame', 'shape', 'board name'],
        alignment:
          'independent on/off buttons, live editor and rendered pixel centering, multi-selection, undo/redo, reopen',
        selectedTextClick:
          'text, note, frame, shape: first click selects, click 800ms later edits, caret at end, typing appends, no pencil buttons',
        textResize: 'all four corners with real pointer drags, font scaling, opposite anchor, undo',
        transforms:
          'all four edges on text and notes; 90/180 degree rotation, angle, local-axis resize, rotated editor, Escape, persistence',
        selectionControls: 'near object and following live movement, pan and zoom',
        textEditing:
          'visible toolbar, live grow/shrink, color keeps focus and draft, empty blur deletes, undo restores, duplicate includes draft',
        crop: 'real right-click, pointer drag, apply, persisted, undo/redo',
        close: 'active name and crop persisted',
        errors,
      },
      null,
      2,
    ),
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
