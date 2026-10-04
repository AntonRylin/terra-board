// Drive Chromium's real mouse/keyboard input in the packaged Electron app.
// Use an isolated repository-local library; never touch the user's boards.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
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

  const tcp = createServer();
  await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
  const mcpPort = tcp.address().port;
  await new Promise((r) => tcp.close(r));
  assert.equal(await read('window.canvas.mcpStatus().then(s=>s.enabled)'), false);
  await until(
    async () =>
      (await documentState()).objects
        .filter((o) => o.type === 'text')
        .every((o) => o.height !== 40),
    'initial text layout saved',
  );
  const beforeSettings = await documentState();
  await read('window.settingsCanvas = document.querySelector("canvas")');
  await key('a', 'KeyA', 2);
  await clickSelector('[aria-label="Library options"]');
  const settings = await read(
    `(()=>{const e=[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.includes('Settings'));const r=e?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`,
  );
  assert.ok(settings);
  await click(settings.x, settings.y);
  await until(() => rect('[aria-label="Enable MCP server"]'), 'MCP settings');
  assert.equal(
    await read(`(() => {
    const r = document.querySelector('.settings-page').getBoundingClientRect();
    return r.x === 0 && r.y === 0 && Math.abs(r.width - innerWidth) < 1 && Math.abs(r.height - innerHeight) < 1
      && !document.querySelector('.modal-backdrop') && document.querySelector('.app-shell').inert;
  })()`),
    true,
    'Settings fills the window without a modal',
  );
  await key('Delete', 'Delete');
  await clickSelector('.settings-page h1');
  await key('Delete', 'Delete');
  await key('k', 'KeyK', 2);
  assert.equal(
    await read('!!document.querySelector(".search-input")'),
    false,
    'Board search is blocked',
  );
  assert.deepEqual(
    (await documentState()).objects,
    beforeSettings.objects,
    'Settings blocks board deletion',
  );
  // Use an isolated free port, then exercise the real enable switch.
  await read(`window.canvas.mcpUpdate({enabled:false,port:${mcpPort}})`);
  await clickSelector('[aria-label="MCP port"]');
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: String(mcpPort) });
  await clickSelector('[aria-label="Enable MCP server"]');
  await until(() => read('window.canvas.mcpStatus().then(s=>s.running)'), 'server running');
  await until(
    () =>
      read(
        `document.querySelector('[aria-label="Enable MCP server"]').getAttribute('aria-checked')==='true'`,
      ),
    'enabled switch',
  );
  await clickSelector('[aria-label="Copy Claude setup"]');
  await until(
    () =>
      read(
        `document.querySelector('.settings-page .toast')?.textContent === 'Claude setup prompt copied'`,
      ),
    'copy toast',
  );
  assert.equal(await read('!!document.querySelector(".mcp-settings textarea")'), false);
  await sleep(300);
  writeFileSync(
    join(root, 'mcp-settings.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  await clickSelector('[aria-label="Back to board"]');
  assert.equal(
    await read(
      'window.settingsCanvas === document.querySelector("canvas") && !document.querySelector(".app-shell").inert',
    ),
    true,
    'Board stays mounted and becomes interactive',
  );
  const config = JSON.parse(readFileSync(join(root, 'settings', 'mcp.json'), 'utf8'));
  const client = new Client({ name: 'codex-desktop-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer ' + config.token } },
    }),
  );
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, r.content[0]?.text);
    return JSON.parse(r.content[0].text);
  };
  assert.equal((await client.listTools()).tools.length, 11);
  // Unsaved typing must be flushed before the AI reads the board.
  await doubleClick(host.x + 160, host.y + 440);
  await until(() => rect('.text-editor'), 'editor');
  await key('a', 'KeyA', 2);
  await send('Input.insertText', { text: 'Unsaved user draft' });
  const before = await call('read_board', { id: board.id });
  assert.equal(before.objects.find((o) => o.id === 'caption-left').text, 'Unsaved user draft');
  const original = before.objects.find((o) => o.id === 'caption-left');
  await call('edit_board', {
    id: board.id,
    revision: before.revision,
    upserts: [{ ...original, text: 'AI edit with undo', bold: true }],
  });
  await doubleClick(host.x + 160, host.y + 440);
  assert.equal(await read(`document.querySelector('.text-editor').value`), 'AI edit with undo');
  await key('Escape', 'Escape');
  await key('z', 'KeyZ', 2);
  await until(
    async () =>
      (await documentState()).objects.find((o) => o.id === 'caption-left').text ===
      'Unsaved user draft',
    'AI edit undo',
  );
  await key('z', 'KeyZ', 10);
  await until(
    async () =>
      (await documentState()).objects.find((o) => o.id === 'caption-left').text ===
      'AI edit with undo',
    'AI edit redo',
  );
  const upload = await call('import_media', {
    file: join(root, 'assets', asset.id + '.original'),
    name: 'MCP photo.png',
  });
  const d = await call('read_board', { id: board.id });
  await call('edit_board', {
    id: board.id,
    revision: d.revision,
    upserts: [
      {
        id: 'mcp-photo',
        type: 'image',
        assetId: upload.id,
        x: 900,
        y: 100,
        width: 250,
        height: 125,
        z: 6,
      },
    ],
  });
  assert.equal(
    (await documentState()).objects.some((o) => o.id === 'mcp-photo'),
    true,
  );
  const picture = await client.callTool({ name: 'read_asset', arguments: { id: upload.id } });
  assert.equal(picture.content[1].type, 'image');
  const claude = new Client({ name: 'claude-desktop-test', version: '1' });
  const claudeSettings = JSON.parse(await read('window.canvas.mcpStatus().then(s=>s.claudeConfig)'))
    .mcpServers.terra_board;
  const stdio = new StdioClientTransport({
    ...claudeSettings,
    env: { ...env, ...claudeSettings.env },
    stderr: 'pipe',
  });
  await claude.connect(stdio);
  assert.equal((await claude.listTools()).tools.length, 11);
  const listed = await claude.callTool({ name: 'list_boards', arguments: {} });
  assert.ok(!listed.isError, listed.content[0]?.text);
  // Exercise the board lifecycle through the packaged connector, then open
  // the result through the real launcher to verify the UI sees MCP changes.
  const stdioCall = async (name, args = {}) => {
    const result = await claude.callTool({ name, arguments: args });
    assert.ok(!result.isError, result.content[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  const folder = await stdioCall('create_folder', { name: 'MCP checks' });
  const created = await stdioCall('create_board', { name: 'MCP board', folderId: folder.id });
  for (const color of ['blue', 'green', 'purple', 'orange', 'rose', 'gray', 'yellow']) {
    await stdioCall('update_board', { id: created.id, patch: { color } });
    assert.equal((await stdioCall('read_board', { id: created.id })).board.color, color);
  }
  for (const icon of ['none', 'lightbulb', 'emoji:🌿', 'asset-' + upload.id]) {
    await stdioCall('update_board', { id: created.id, patch: { icon } });
    assert.equal((await stdioCall('read_board', { id: created.id })).board.icon, icon);
  }
  const boardPatch = {
    name: 'MCP verified board',
    iconShape: 'circle',
    showInitial: false,
    folderId: null,
    position: 0.5,
  };
  await stdioCall('update_board', { id: created.id, patch: boardPatch });
  const configured = (await stdioCall('read_board', { id: created.id })).board;
  for (const [field, value] of Object.entries(boardPatch)) assert.equal(configured[field], value);
  await stdioCall('edit_board', {
    id: created.id,
    revision: 0,
    upserts: [
      {
        id: 'journey',
        type: 'frame',
        x: 100,
        y: 150,
        width: 690,
        height: 230,
        z: 1,
        text: 'MCP gallery',
        gallery: { direction: 'below', size: 320, gap: 20 },
      },
      {
        id: 'original',
        type: 'image',
        x: 115,
        y: 195,
        width: 320,
        height: 160,
        z: 2,
        assetId: upload.id,
        imageTitle: 'Imported image',
        galleryId: 'journey',
        galleryIndex: 0,
        galleryRow: 0,
        galleryColumn: 0,
      },
    ],
  });
  const gallery = await stdioCall('read_board', { id: created.id });
  const source = gallery.objects.find((o) => o.id === 'original');
  await stdioCall('edit_board', {
    id: created.id,
    revision: gallery.revision,
    upserts: [
      {
        ...source,
        id: 'image-copy',
        x: 455,
        z: 3,
        imageTitle: 'Copied image',
        galleryIndex: 1,
        galleryColumn: 1,
      },
    ],
  });
  await clickSelector('[aria-label="Open board MCP verified board"]');
  await until(
    () =>
      read(`document.querySelector('.board-title')?.textContent === 'MCP verified board'
    && !!document.querySelector('canvas') && !document.querySelector('.canvas-loading')`),
    'open MCP-created board',
  );
  await until(
    () =>
      read(
        `!!document.querySelector('[aria-label="Open board MCP verified board"] .board-image-icon')?.naturalWidth`,
      ),
    'MCP icon visible',
  );
  await sleep(500);
  writeFileSync(
    join(root, 'mcp-created-board.png'),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  const complete = await stdioCall('read_board', { id: created.id });
  assert.equal(complete.objects.length, 3);
  assert.equal(complete.objects.find((o) => o.id === 'image-copy').assetId, upload.id);
  assert.equal(complete.objects.find((o) => o.id === 'image-copy').galleryColumn, 1);
  const duplicate = await stdioCall('duplicate_board', { id: created.id });
  assert.equal((await stdioCall('read_board', { id: duplicate.id })).objects.length, 3);
  assert.equal(duplicate.icon, 'asset-' + upload.id);
  await stdioCall('update_board', { id: duplicate.id, patch: { trashed: true } });
  assert.equal((await stdioCall('read_board', { id: duplicate.id })).board.trashed, true);
  await stdioCall('update_board', { id: duplicate.id, patch: { trashed: false } });
  await stdioCall('update_folder', {
    id: folder.id,
    patch: { name: 'Renamed checks', position: 4 },
  });
  await stdioCall('remove_folder', { id: folder.id });
  await clickSelector('[aria-label="Open board Desktop input verification"]');
  await until(
    () =>
      read(`document.querySelector('.board-title')?.textContent === 'Desktop input verification'`),
    'original board reopened',
  );
  await clickSelector('[aria-label="Library options"]');
  await click(settings.x, settings.y);
  await until(() => rect('[aria-label="Enable MCP server"]'), 'reopen settings');
  await until(
    () =>
      read(
        `document.querySelector('[aria-label="Enable MCP server"]').getAttribute('aria-checked')==='true'`,
      ),
    'switch still enabled',
  );
  await clickSelector('[aria-label="Enable MCP server"]');
  await until(
    () => read('window.canvas.mcpStatus().then(s=>!s.running&&!s.enabled)'),
    'disabled switch',
  );
  assert.equal((await claude.callTool({ name: 'list_boards', arguments: {} })).isError, true);
  await assert.rejects(client.callTool({ name: 'list_boards', arguments: {} }));
  await claude.close();
  await client.close();
  await key('Escape', 'Escape');
  assert.equal(
    await read('!document.querySelector(".settings-page")'),
    true,
    'Escape returns to board',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      library: root,
      http: true,
      packagedStdio: true,
      liveEdit: true,
      draftPreserved: true,
      undo: true,
      redo: true,
      upload: true,
      boardSettings: true,
      boardCreationAndOpening: true,
      galleryCopy: true,
      duplicateAndTrash: true,
      disable: true,
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
