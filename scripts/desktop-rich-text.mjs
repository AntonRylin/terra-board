// Inline formatting on canvas text and notes, in the packaged app with real
// Chromium input: the format bar on a selection, canvas rendering that matches
// the editor, spoilers that reveal for this viewer only, save, reload, export.
// Uses an isolated repository-local library; never touches the user's boards.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const sharp = require('sharp');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-rich-text-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Rich text' });
store.setLastBoard({ id: board.id });
store.saveCamera({ id: board.id, camera: { x: 0, y: 0, zoom: 1.5 } });
const noteText = 'Plain words and a big secret ending here';
const freeText = 'Free text with code inside';
store.patchBoard({
  id: board.id,
  revision: store.loadBoard({ id: board.id }).revision,
  upserts: [
    {
      id: 'note',
      type: 'note',
      x: 60,
      y: 60,
      width: 300,
      height: 230,
      z: 1,
      text: noteText,
      color: '#f8efd4',
      fontSize: 21,
    },
    {
      id: 'text',
      type: 'text',
      x: 60,
      y: 330,
      width: 260,
      height: 30,
      z: 2,
      text: freeText,
      color: '#29313b',
      fontSize: 18,
    },
  ],
});
store.close();
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const env = { ...process.env, CANVAS_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const exportCheck = !!process.env.TERRA_EXPORT_CHECK;
const harness = join(root, 'export-main.cjs');
if (exportCheck)
  writeFileSync(
    harness,
    `
const {dialog}=require('electron');
dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(join(root, 'note-export.png'))}});
require(${JSON.stringify(resolve('electron/main.cjs'))});
`,
  );
const child = spawn(
  exportCheck
    ? require('electron')
    : resolve(process.env.TERRA_TEST_EXE || 'release/win-unpacked/Terra Board.exe'),
  [
    ...(exportCheck ? [harness] : []),
    `--remote-debugging-port=${port}`,
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
  { env, windowsHide: true, stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(60);
  }
  throw Error('Timed out: ' + label);
}
let socket,
  seq = 0;
const pending = new Map(),
  errors = [];
function send(method, params = {}) {
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
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function read(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails)
    throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const rect = (selector) =>
  read(
    `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
  );
async function mouse(type, x, y, buttons = 0, clickCount = 1) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
    buttons,
    clickCount,
  });
}
async function clickAt(x, y, count = 1) {
  await mouse('mouseMoved', x, y);
  for (let i = 1; i <= count; i++) {
    await mouse('mousePressed', x, y, 1, i);
    await mouse('mouseReleased', x, y, 0, i);
  }
}
async function click(selector) {
  const r = await until(() => rect(selector), selector);
  await clickAt(r.x + r.width / 2, r.y + r.height / 2);
}
const key = async (key, code = key, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
};
const ctrl = 2,
  shift = 8;
const state = () => read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
const object = async (id) => (await state()).objects.find((o) => o.id === id);
const screenshot = async (name) =>
  writeFileSync(
    join(root, name),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
// Raw RGB pixels of a page region, in CSS pixels.
async function pixels(r) {
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 },
  });
  return sharp(Buffer.from(data, 'base64')).removeAlpha().raw().toBuffer();
}
const difference = (a, b) => {
  let total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) total += Math.abs(a[i] - b[i]);
  return total / Math.min(a.length, b.length);
};
// Text ranges of the open editor, measured on screen.
const editorRange = (start, end) =>
  read(`(() => {
    const root = document.querySelector('.text-editor');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let at = 0, from, to;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const length = n.data.length;
      if (!from && ${start} < at + length) from = [n, ${start} - at];
      if (!to && ${end} <= at + length) to = [n, ${end} - at];
      at += length;
    }
    const range = document.createRange();
    range.setStart(...from);
    range.setEnd(...to);
    const r = range.getClientRects()[0];
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
// Drag from inside the first character's left half to the last one's right half.
async function selectWord(start, end, word) {
  const first = await editorRange(start, start + 1),
    last = await editorRange(end - 1, end);
  const from = { x: first.x + 1, y: first.y + first.height / 2 },
    to = { x: last.x + last.width - 1, y: last.y + last.height / 2 };
  await mouse('mouseMoved', from.x, from.y);
  await mouse('mousePressed', from.x, from.y, 1);
  for (let step = 1; step <= 8; step++) {
    await mouse(
      'mouseMoved',
      from.x + ((to.x - from.x) * step) / 8,
      from.y + ((to.y - from.y) * step) / 8,
      1,
    );
    await sleep(16);
  }
  await mouse('mouseReleased', to.x, to.y);
  await until(() => read(`String(getSelection())===${JSON.stringify(word)}`), 'select ' + word);
  await until(() => rect('.rich-format-bar'), 'format bar for ' + word);
}
async function finishEditing() {
  await clickAt(900, 620);
  await until(() => read(`!document.querySelector('.text-editor')`), 'editing finished');
  await sleep(400);
}
const editorOpen = (id) =>
  until(
    () => read(`document.activeElement===document.querySelector('.text-editor.rt-field')`),
    id + ' rich editor',
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
    } else if (m.method === 'Runtime.exceptionThrown')
      errors.push(
        m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text,
      );
  });
  await send('Runtime.enable');
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await until(
    () =>
      read(
        `!!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading')`,
      ),
    'canvas',
  );
  await sleep(800);
  const host = await rect('.canvas-surface');
  const zoom = 1.5;
  const toScreen = (x, y) => ({ x: host.x + x * zoom, y: host.y + y * zoom });

  // Note: open it, format words from the bar.
  const noteCenter = toScreen(210, 175);
  await clickAt(noteCenter.x, noteCenter.y, 2);
  await editorOpen('note');
  await selectWord(18, 21, 'big');
  await click('.rich-format-bar [aria-label="Larger text"]');
  await click('.rich-format-bar [aria-label="Larger text"]');
  await click('.rich-format-bar [aria-label="Bold"]');
  await click('.rich-format-bar [aria-label="Text color"]');
  await click('.rich-format-bar [aria-label="#e5484d"]');
  assert.equal(await read(`String(getSelection())`), 'big', 'formatting keeps the selection');
  await selectWord(22, 28, 'secret');
  // Extend the selection over "secret ending" with the keyboard and hide it.
  for (let i = 0; i < 7; i++)
    for (const type of ['rawKeyDown', 'keyUp'])
      await send('Input.dispatchKeyEvent', {
        type,
        key: 'ArrowRight',
        code: 'ArrowRight',
        windowsVirtualKeyCode: 39,
        modifiers: shift,
      });
  await until(() => read(`String(getSelection())==='secret ending'`), 'extended selection');
  await key('P', 'KeyP', ctrl | shift);
  await until(
    () => read(`document.querySelector('.text-editor .rt-spoiler')?.textContent==='secret ending'`),
    'spoiler applied',
  );
  assert.equal(
    await read(`getComputedStyle(document.querySelector('.text-editor')).fontFamily`),
    '"Segoe Print", "Segoe UI", sans-serif',
  );
  assert.equal(
    await read(`document.querySelector('.rich-format-font').textContent`),
    'Default',
    'a note’s own font is the default',
  );
  // Collapse the caret, then measure the editor's text where the canvas will draw it.
  for (const type of ['rawKeyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', {
      type,
      key: 'End',
      code: 'End',
      windowsVirtualKeyCode: 35,
    });
  await until(
    () => read(`getSelection().isCollapsed && !document.querySelector('.rich-format-bar')`),
    'bar closes',
  );
  const big = await editorRange(18, 21);
  const spoilerRects = await read(
    `Array.from(document.querySelector('.text-editor .rt-spoiler').getClientRects(), r => ({x:r.x,y:r.y,width:r.width,height:r.height}))`,
  );
  const wordBox = { x: big.x - 4, y: big.y, width: big.width + 8, height: big.height };
  // The caret blinks; hide it for the comparison.
  await read(`document.querySelector('.text-editor').style.caretColor='transparent'`);
  await sleep(150);
  const editing = await pixels(wordBox);
  await screenshot('note-editing.png');
  await finishEditing();
  const saved = await until(async () => {
    const o = await object('note');
    return o?.textMarks?.length === 2 && o;
  }, 'note formatting saved');
  assert.deepEqual(saved.textMarks, [
    { start: 18, end: 21, bold: true, color: '#e5484d', size: 1.5 },
    { start: 22, end: 35, spoiler: true },
  ]);
  assert.equal(saved.text, noteText, 'text stays plain');
  const drawn = await pixels(wordBox);
  const wordDifference = difference(editing, drawn);
  assert.ok(
    wordDifference < 18,
    `canvas draws the word where the editor had it (${wordDifference})`,
  );
  await screenshot('note-canvas.png');

  // Spoilers: hidden on canvas, revealed by a click for this viewer only.
  const spoilerBox = spoilerRects.at(-1);
  const hidden = await pixels(spoilerBox);
  await sleep(250);
  const hiddenLater = await pixels(spoilerBox);
  assert.ok(difference(hidden, hiddenLater) > 0.5, 'dust drifts');
  assert.equal(
    await read(`document.querySelector('.selection-tools')?.checkVisibility?.() ?? false`),
    false,
  );
  await clickAt(spoilerBox.x + spoilerBox.width / 2, spoilerBox.y + spoilerBox.height / 2);
  await sleep(900);
  const revealed = await pixels(spoilerBox);
  const revealDifference = difference(hidden, revealed);
  assert.ok(revealDifference > 8, `click reveals the text (${revealDifference})`);
  assert.equal(
    await read(`document.querySelector('.selection-tools')?.checkVisibility?.() ?? false`),
    false,
    'revealing does not select the note',
  );
  await sleep(500);
  assert.deepEqual((await object('note')).textMarks, saved.textMarks, 'reveal is not saved');
  await screenshot('note-revealed.png');
  // Clicking again hides it.
  await clickAt(spoilerBox.x + spoilerBox.width / 2, spoilerBox.y + spoilerBox.height / 2);
  await sleep(700);
  assert.ok(difference(revealed, await pixels(spoilerBox)) > revealDifference / 2, 'hides again');
  await clickAt(spoilerBox.x + spoilerBox.width / 2, spoilerBox.y + spoilerBox.height / 2);
  await sleep(900);

  // Ctrl+B without a selection keeps toggling the whole object.
  await clickAt(noteCenter.x, noteCenter.y + 60, 2);
  await editorOpen('note again');
  for (const type of ['rawKeyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', {
      type,
      key: 'End',
      code: 'End',
      windowsVirtualKeyCode: 35,
      modifiers: ctrl,
    });
  await until(() => read(`getSelection().isCollapsed`), 'caret only');
  await key('b', 'KeyB', ctrl);
  await finishEditing();
  await until(async () => (await object('note')).bold === true, 'object bold');
  assert.deepEqual((await object('note')).textMarks, saved.textMarks);

  // Free text: monospace from the bar, saved beside plain text.
  const textCenter = toScreen(120, 345);
  await clickAt(textCenter.x, textCenter.y);
  await sleep(500);
  await clickAt(textCenter.x, textCenter.y);
  await editorOpen('text');
  await selectWord(15, 19, 'code');
  await click('.rich-format-bar [aria-label="Monospace"]');
  await click('.rich-format-bar [aria-label="Italic"]');
  await finishEditing();
  const text = await until(async () => {
    const o = await object('text');
    return o?.textMarks?.length && o;
  }, 'text formatting saved');
  assert.deepEqual(text.textMarks, [{ start: 15, end: 19, italic: true, code: true }]);
  assert.ok(text.height < 40, 'free text stays one line');
  await screenshot('text-canvas.png');

  if (exportCheck) {
    await clickAt(noteCenter.x, noteCenter.y - 80);
    await click('[aria-label="Canvas options"]');
    const index = await read(
      `Array.from(document.querySelectorAll('.context-menu button')).findIndex(b=>b.textContent.trim()==='Export selected…')+1`,
    );
    assert.ok(index > 0);
    await click(`.context-menu button:nth-of-type(${index})`);
    await click('.export-formats button');
    await until(() => existsSync(join(root, 'note-export.png')), 'note PNG export');
    const { data, info } = await sharp(join(root, 'note-export.png'))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let red = 0;
    for (let i = 0; i < data.length; i += info.channels)
      if (data[i] > 180 && data[i + 1] < 110 && data[i + 2] < 110) red++;
    assert.ok(red > 40, 'export draws the coloured word');
  }

  // Reopen in dark mode: formatting survives, the reveal does not.
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await read('window.__beforeRichReload=true');
  await send('Page.reload');
  await until(
    () =>
      read(
        `!window.__beforeRichReload && !document.getElementById('startup-screen') && !!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading')`,
      ),
    'reload',
  );
  await sleep(1200);
  await screenshot('rich-dark.png');
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await sleep(600);
  assert.ok(
    difference(revealed, await pixels(spoilerBox)) > revealDifference / 2,
    'spoiler is hidden again after reopening',
  );
  assert.deepEqual((await object('note')).textMarks, saved.textMarks);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      root,
      wordDifference,
      revealDifference,
      checks: [
        'format bar on a note selection',
        'size, bold, colour, spoiler shortcut',
        'canvas matches the editor',
        'dust drifts',
        'local reveal without selecting or saving',
        'object bold with no selection',
        'free text monospace and italic',
        'reload hides spoilers again',
        ...(exportCheck ? ['export draws formatting'] : []),
      ],
    }),
  );
} catch (error) {
  console.error(error);
  if (socket) {
    try {
      await screenshot('failure.png');
    } catch {}
  }
  console.error('Library:', root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
