import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-lists-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Lists' });
store.patchBoard({
  id: board.id,
  revision: 0,
  deleted: [],
  camera: { x: 0, y: 0, zoom: 1 },
  upserts: [
    {
      id: 'list',
      type: 'list',
      x: 400,
      y: 180,
      width: 320,
      height: 188,
      z: 1,
      text: 'List',
      items: [
        { id: 'a', text: 'Short item', checked: false },
        { id: 'b', text: 'Second item', checked: false },
      ],
    },
    {
      id: 'text',
      type: 'text',
      x: 400,
      y: 650,
      width: 180,
      height: 180,
      z: 2,
      text: 'Short text',
      fontSize: 24,
      textBox: true,
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
const source = !!process.env.TERRA_SOURCE_CHECK;
const exportCheck = !!process.env.TERRA_EXPORT_CHECK;
const harness = join(root, 'export-main.cjs');
if (exportCheck)
  writeFileSync(
    harness,
    `
const {dialog}=require('electron');
dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(join(root, 'list-export.png'))}});
require(${JSON.stringify(resolve('electron/main.cjs'))});
`,
  );
const child = spawn(
  source || exportCheck
    ? require('electron')
    : resolve(process.env.TERRA_TEST_EXE || 'release/win-unpacked/Terra Board.exe'),
  [...(exportCheck ? [harness] : source ? [resolve('.')] : []), `--remote-debugging-port=${port}`],
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
async function mouse(type, x, y, buttons = 0, clickCount = 1, modifiers = 0) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
    buttons,
    clickCount,
    modifiers,
  });
}
async function click(selector) {
  const r = await until(() => rect(selector), selector);
  const x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, 1);
  await mouse('mouseReleased', x, y);
}
async function doubleClick(selector) {
  const r = await until(() => rect(selector), selector);
  const x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  await mouse('mouseMoved', x, y);
  for (const count of [1, 2]) {
    await mouse('mousePressed', x, y, 1, count);
    await mouse('mouseReleased', x, y, 0, count);
  }
}
const key = async (key, code = key, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
};
const state = () => read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
const screenshot = async (name) =>
  writeFileSync(
    join(root, name),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
try {
  const target = await until(async () => {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === 'page' && t.url.startsWith('canvas-app:'),
      );
    } catch {}
  }, 'target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p?.reject(Error(m.error.message)) : p?.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
  });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await until(
    () =>
      read(
        `!!document.querySelector('.canvas-list') && !document.querySelector('.canvas-loading') && !document.getElementById('startup-screen')`,
      ),
    'canvas',
  );
  const failures = [];
  await doubleClick('.canvas-list-header');
  await click('[aria-label="List item 1"]');
  await read(`document.querySelector('[aria-label="List item 1"]').select()`);
  const long =
    'Read every word of this list item including the final ending. ' + 'qdwqedqwdqwdwqd'.repeat(8);
  await send('Input.insertText', { text: long });
  const wrapped = await read(
    `(()=>{const e=document.querySelector('[aria-label="List item 1"]');return {tag:e.tagName,h:e.clientHeight,sh:e.scrollHeight,w:e.clientWidth,sw:e.scrollWidth};})()`,
  );
  if (!(
    wrapped.tag === 'TEXTAREA' &&
    wrapped.h > 44 &&
    wrapped.sh <= wrapped.h + 1 &&
    wrapped.sw <= wrapped.w + 1
  ))
    failures.push({ wrapping: wrapped });
  await key('Escape');
  await mouse('mousePressed', 450, 665, 1, 1);
  await mouse('mouseReleased', 450, 665, 0, 1);
  await mouse('mousePressed', 450, 665, 1, 2);
  await mouse('mouseReleased', 450, 665, 0, 2);
  await until(() => read(`!!document.querySelector('.text-editor')`), 'text editor');
  await read(`document.querySelector('.text-editor').select()`);
  const typed =
    'This plain text must wrap inside the chosen width so the complete ending stays visible.';
  await send('Input.insertText', { text: typed });
  const plain = await read(
    `(()=>{const e=document.querySelector('.text-editor');return {w:e.clientWidth,sw:e.scrollWidth,h:e.clientHeight,sh:e.scrollHeight,font:parseFloat(getComputedStyle(e).fontSize)};})()`,
  );
  if (!(plain.w <= 180 && plain.font <= 24 && plain.sw <= plain.w + 1 && plain.sh <= plain.h + 1))
    failures.push({ plain });
  await key('Enter', 'Enter', 2);
  await until(
    async () => (await state()).objects.find((o) => o.id === 'text').text === typed,
    'text saved',
  );
  await screenshot('text-lists-overflow.png');
  assert.deepEqual(failures, []);
  const textState = async () => (await state()).objects.find((o) => o.id === 'text');
  assert.equal((await textState()).width, 180, 'editing retains the chosen text box width');
  // Observe the actual renderer's draw calls, grouped by texture, to ensure it
  // paints every character after wrapping (not just the visible first rows).
  await read(`(() => {
    const original = CanvasRenderingContext2D.prototype.fillText;
    const groups = new WeakMap();
    window.__textPaints = [];
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
      let group = groups.get(this.canvas);
      if (!group) { group = []; groups.set(this.canvas, group); window.__textPaints.push(group); }
      group.push(text);
      return original.call(this, text, ...args);
    };
  })()`);
  async function resizeText(edge, dx, dy) {
    const before = await textState();
    const x = before.x + (edge === 'e' ? before.width : before.width / 2);
    const y = before.y + (edge === 's' ? before.height : before.height / 2);
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, 1, 1, 1);
    for (let i = 1; i <= 8; i++)
      await mouse('mouseMoved', x + (dx * i) / 8, y + (dy * i) / 8, 1, 1, 1);
    await mouse('mouseReleased', x + dx, y + dy);
    return until(async () => {
      const next = await textState();
      return (next.width !== before.width || next.height !== before.height) && next;
    }, 'text resize ' + edge);
  }
  const narrowed = await resizeText('e', -90, 0);
  assert.equal(narrowed.width, 90);
  const compact = (text) => text.replace(/\s/g, '');
  await until(
    async () =>
      (await read('window.__textPaints')).some(
        (lines) => lines.length > 1 && compact(lines.join('')) === compact(typed),
      ),
    'all wrapped text painted',
  );
  async function checkEditor(text, maximumFont = 24) {
    const object = await textState();
    await mouse('mousePressed', object.x + object.width / 2, object.y + object.height / 2, 1);
    await mouse('mouseReleased', object.x + object.width / 2, object.y + object.height / 2);
    await until(() => read(`!!document.querySelector('.text-editor')`), 'resized text editor');
    if (text !== undefined) {
      await read(`document.querySelector('.text-editor').select()`);
      await send('Input.insertText', { text });
    }
    const metrics = await read(`(() => {
      const e = document.querySelector('.text-editor'), s = getComputedStyle(e);
      return { w: e.clientWidth, sw: e.scrollWidth, h: e.clientHeight, sh: e.scrollHeight,
        font: parseFloat(s.fontSize), value: e.value };
    })()`);
    assert.ok(metrics.w <= object.width && metrics.h <= object.height, JSON.stringify(metrics));
    assert.ok(metrics.sw <= metrics.w + 1 && metrics.sh <= metrics.h + 1, JSON.stringify(metrics));
    assert.ok(metrics.font < maximumFont, 'font shrinks to keep every line visible');
    await key('Enter', 'Enter', 2);
    await until(async () => (await textState()).text === metrics.value, 'resized text saved');
    return metrics;
  }
  const narrowEditor = await checkEditor();
  const shortened = await resizeText('s', 0, -100);
  assert.equal(shortened.height, 80);
  await checkEditor(undefined, narrowEditor.font);
  await checkEditor('Supercalifragilisticexpialidocious'.repeat(4) + '\n🧑‍🚀你好🌍 Final ending\n');
  await checkEditor(typed);
  await screenshot('text-narrowed.png');
  await doubleClick('.canvas-list-header');
  await click('[aria-label="List item 1"]');
  await read(`document.querySelector('[aria-label="List item 1"]').select()`);
  const sentence = 'A wider list shows this entire sentence on one readable line.';
  await send('Input.insertText', { text: sentence });
  await key('Escape');
  const listState = async () => (await state()).objects.find((o) => o.id === 'list');
  await until(async () => (await listState()).items[0].text === sentence, 'list saved');
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1, `${a} should equal ${b}`);
  async function dragHandle(edge, dx, dy) {
    const r = await rect('.canvas-list');
    const x = r.x + (edge.includes('e') ? r.width : edge.includes('w') ? 0 : r.width / 2);
    const y = r.y + (edge.includes('s') ? r.height : edge.includes('n') ? 0 : r.height / 2);
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, 1, 1, 1);
    for (let i = 1; i <= 8; i++)
      await mouse('mouseMoved', x + (dx * i) / 8, y + (dy * i) / 8, 1, 1, 1);
    await mouse('mouseReleased', x + dx, y + dy);
    return until(async () => {
      const next = await listState();
      return (Math.abs(next.width - r.width) > 1 || Math.abs(next.height - r.height) > 1) && next;
    }, 'resize ' + edge);
  }
  let before = await listState();
  let resized = await dragHandle('e', 400, 0);
  near(resized.width, before.width + 400);
  near(resized.height, before.height);
  near(resized.x, before.x);
  assert.equal(resized.listScale, 1);
  const singleLine = await read(
    `document.querySelector('[aria-label="List item 1"]').clientHeight`,
  );
  assert.equal(singleLine, 32, 'widening makes room for the whole sentence on one line');
  for (const [edge, dx, dy] of [
    ['w', -60, 0],
    ['s', 0, 60],
    ['n', 0, -40],
  ]) {
    before = resized;
    resized = await dragHandle(edge, dx, dy);
    near(resized.width, before.width + (edge === 'w' ? 60 : 0));
    near(resized.height, before.height + (edge === 's' ? 60 : edge === 'n' ? 40 : 0));
    near(resized.x, before.x + (edge === 'w' ? -60 : 0));
    near(resized.y, before.y + (edge === 'n' ? -40 : 0));
    assert.equal(resized.listScale, 1);
  }
  before = resized;
  resized = await dragHandle('se', before.width * 0.1, before.height * 0.1);
  near(resized.width, before.width * 1.1);
  near(resized.height, before.height * 1.1);
  assert.ok(Math.abs(resized.listScale - 1.1) < 0.001);
  await screenshot('list-widened.png');
  await read('window.__beforeOverflowReload=true');
  await send('Page.reload');
  await until(
    () =>
      read(
        `!window.__beforeOverflowReload && !document.getElementById('startup-screen') && document.querySelector('[aria-label="List item 1"]')?.value===${JSON.stringify(sentence)}`,
      ),
    'reload',
  );
  assert.equal((await listState()).listScale, resized.listScale);
  assert.equal((await state()).objects.find((o) => o.id === 'text').text, typed);
  assert.equal((await textState()).width, 90, 'reload preserves narrowed width');
  assert.equal((await textState()).height, 80, 'reload preserves shortened height');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'TEXT_LISTS_OVERFLOW_OK', root, wrapped, plain }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  if (socket)
    try {
      await screenshot('failure.png');
    } catch {}
} finally {
  socket?.close();
  child.kill();
}
