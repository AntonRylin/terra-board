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
  await until(
    () =>
      read(
        `!!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading')`,
      ),
    'canvas',
  );
  await sleep(600);
  await click('[aria-label="Insert"]');
  assert.ok(
    await read(`!!document.querySelector('.insert-menu [aria-label="Add list"]')`),
    'the plus menu offers List',
  );
  await click('.insert-menu [aria-label="Add list"]');
  await until(() => read(`document.querySelectorAll('.canvas-list').length===1`), 'new list');
  assert.equal(await read(`document.querySelector('.canvas-list').innerText.trim()`), '');
  assert.equal(await read(`document.querySelector('[aria-label="List name"]').value`), 'Title');
  assert.ok(
    await read(
      `Math.abs(document.querySelector('[aria-label="List name"]').getBoundingClientRect().left - document.querySelector('.canvas-list-row input').getBoundingClientRect().left) < 1`,
    ),
    'title aligns with item text',
  );
  assert.deepEqual(
    await read(
      `Array.from(document.querySelectorAll('.canvas-list-row input'), input=>input.value)`,
    ),
    ['Item 1', 'Item 2'],
  );
  assert.equal(
    await read(
      `Array.from(document.querySelectorAll('.canvas-list-circle')).every(circle=>circle.getAttribute('aria-checked')==='false')`,
    ),
    true,
  );
  assert.equal(
    await read(`!!document.querySelector('[aria-label="Add list item"]')`),
    false,
    'plus is hidden outside edit mode',
  );
  assert.equal(await read(`!!document.querySelector('.canvas-list-grip')`), false, 'no drag dots');
  await key('Escape');
  for (const expected of ['true', 'false']) {
    await click('.canvas-list-circle');
    assert.equal(
      await read(`document.querySelector('.canvas-list-circle').getAttribute('aria-checked')`),
      expected,
    );
    assert.equal(
      await read(`document.querySelector('.canvas-list').dataset.selected`),
      'false',
      'checkbox does not select list',
    );
    assert.equal(
      await read(`document.querySelector('.canvas-list').dataset.editing`),
      'false',
      'checkbox does not start editing',
    );
  }
  await doubleClick('.canvas-list-circle');
  assert.equal(
    await read(`document.querySelector('.canvas-list').dataset.editing`),
    'false',
    'checkbox double click does not edit the card',
  );
  await doubleClick('.canvas-list-header');
  await until(
    () => read(`document.querySelector('.canvas-list').dataset.editing === 'true'`),
    'double click edits list',
  );
  const outline = () =>
    read(`document.querySelector('.canvas-list-edit-outline path')?.getAttribute('d')`);
  const firstOutline = await outline();
  const stableCard = await rect('.canvas-list');
  const stableTitle = await rect('[aria-label="List name"]');
  for (const selector of ['[aria-label="List name"]', '[aria-label="List item 1"]']) {
    await click(selector);
    assert.deepEqual(
      await read(
        `(() => { const s = getComputedStyle(document.querySelector('${selector}')); return [s.outlineStyle, s.boxShadow]; })()`,
      ),
      ['none', 'none'],
      'editing text has no row outline or underline',
    );
  }
  await click('[aria-label="List name"]');
  await sleep(250);
  assert.notEqual(await outline(), firstOutline, 'the border shape itself ripples');
  assert.deepEqual(await rect('.canvas-list'), stableCard, 'ripple does not move the card');
  assert.deepEqual(
    await rect('[aria-label="List name"]'),
    stableTitle,
    'ripple does not move text',
  );
  await screenshot('lists-editing-wave.png');
  await send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-color-scheme', value: 'light' },
    ],
  });
  await sleep(80);
  const stillOutline = await outline();
  await sleep(150);
  assert.equal(await outline(), stillOutline, 'reduced motion stops ripple');
  await send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-motion', value: 'no-preference' },
      { name: 'prefers-color-scheme', value: 'light' },
    ],
  });
  await mouse('mousePressed', 500, 160, 1);
  await mouse('mouseReleased', 500, 160);
  assert.equal(
    await read(`document.querySelector('.canvas-list').dataset.editing`),
    'false',
    'outside click exits edit mode',
  );
  assert.equal(await outline(), undefined, 'outline removed outside editing');
  await doubleClick('.canvas-list-header');
  assert.equal(
    await read(`document.querySelectorAll('.canvas-list-header button').length`),
    0,
    'edit buttons are removed from the list',
  );
  await click('[aria-label="List name"]');
  await read(`document.querySelector('[aria-label="List name"]').select()`);
  await send('Input.insertText', { text: 'Formatting while typing' });
  for (const [label, property, enabled, disabled] of [
    ['Bold', 'fontWeight', '700', '400'],
    ['Strikethrough', 'textDecorationLine', 'line-through', 'none'],
  ]) {
    for (const expected of [enabled, disabled, enabled]) {
      await click('[aria-label="List name"]');
      await read(`document.querySelector('[aria-label="List name"]').select()`);
      await click(`.selection-tools [aria-label="${label}"]`);
      await until(
        () =>
          read(
            `getComputedStyle(document.querySelector('[aria-label="List name"]')).${property} === '${expected}'`,
          ),
        label + ' applies while title focused',
      );
      assert.equal(
        await read(`document.querySelector('[aria-label="List name"]').value`),
        'Formatting while typing',
      );
    }
  }
  assert.equal(
    await read(`getComputedStyle(document.querySelector('[aria-label="List name"]')).fontWeight`),
    '700',
  );
  assert.equal(
    await read(
      `getComputedStyle(document.querySelector('[aria-label="List name"]')).textDecorationLine`,
    ),
    'line-through',
  );
  assert.equal(
    await read(
      `getComputedStyle(document.querySelector('.canvas-list-row input')).textDecorationLine`,
    ),
    'none',
    'title format does not affect items',
  );
  assert.ok(
    await read(`(() => {
    const input = document.querySelector('[aria-label="List name"]');
    const probe = document.createElement('span');
    const style = getComputedStyle(input);
    probe.textContent = 'Weekend away';
    probe.style.cssText = 'position:absolute;white-space:pre;font-family:' + style.fontFamily + ';font-size:30px';
    document.body.append(probe);
    probe.style.fontWeight = '400';
    const normal = probe.getBoundingClientRect().width;
    probe.style.fontWeight = '700';
    const bold = probe.getBoundingClientRect().width;
    probe.remove();
    return Math.abs(bold - normal) > 1;
  })()`),
    'bold title uses distinct bold glyphs, not only a computed weight',
  );
  await click('[aria-label="Remove item 2"]');
  await click('[aria-label="Remove item 1"]');
  await click('[aria-label="Add list item"]');
  await until(
    () => read(`document.activeElement?.getAttribute('aria-label')==='List item 1'`),
    'inline focus',
  );
  await send('Input.insertText', { text: 'Choose a destination' });
  await key('Enter');
  await until(
    () => read(`document.activeElement?.getAttribute('aria-label')==='List item 2'`),
    'Enter adds next row',
  );
  await send('Input.insertText', { text: 'Book the train' });
  await click('.canvas-list-circle');
  assert.equal(
    await read(`document.querySelector('.canvas-list-circle').getAttribute('aria-checked')`),
    'true',
  );
  await click('.canvas-list-circle');
  assert.equal(
    await read(`document.querySelector('.canvas-list-circle').getAttribute('aria-checked')`),
    'false',
  );
  await click('.canvas-list-circle');
  await click('[aria-label="List name"]');
  await until(
    () => read(`document.activeElement?.getAttribute('aria-label')==='List name'`),
    'name focus',
  );
  await read(`document.querySelector('[aria-label="List name"]').select()`);
  await send('Input.insertText', { text: 'Weekend away' });
  await key('Enter');
  const saved = await until(async () => {
    const o = (await state()).objects[0];
    return (
      o?.text === 'Weekend away' &&
      o.bold &&
      o.strikethrough &&
      o.items?.length === 2 &&
      o.items[1].text === 'Book the train' &&
      o.items[0].checked &&
      o
    );
  }, 'durable list');
  await click('[aria-label="List name"]');
  await key('Escape');
  assert.equal(await read(`!!document.querySelector('[aria-label="Add list item"]')`), false);
  assert.equal(
    await read(
      `Array.from(document.querySelectorAll('.canvas-list input')).every(input=>input.readOnly)`,
    ),
    true,
  );
  assert.equal(
    await read(`getComputedStyle(document.querySelector('.canvas-list')).borderTopColor`),
    'rgb(68, 134, 217)',
  );
  await click('.canvas-list-circle');
  assert.equal(
    await read(`document.querySelector('.canvas-list-circle').getAttribute('aria-checked')`),
    'false',
    'checking remains available outside edit mode',
  );
  await click('.canvas-list-circle');
  const before = await rect('.canvas-list-name');
  const x = before.x + before.width / 2,
    y = before.y + before.height / 2;
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, 1);
  await mouse('mouseMoved', x + 100, y + 50, 1);
  await mouse('mouseReleased', x + 100, y + 50);
  const moved = await until(async () => {
    const o = (await state()).objects[0];
    return o.x > saved.x + 50 && o;
  }, 'drag list');
  await key('z', 'KeyZ', 2);
  await until(async () => (await state()).objects[0].x === saved.x, 'undo movement');
  await key('z', 'KeyZ', 10);
  await until(async () => (await state()).objects[0].x === moved.x, 'redo movement');
  const widthBefore = (await rect('.canvas-list')).width;
  await click('[aria-label="Zoom in"]');
  await until(
    async () => (await rect('.canvas-list')).width > widthBefore * 1.1,
    'zoom follows canvas',
  );
  const style = await read(
    `(()=>{const s=getComputedStyle(document.querySelector('.canvas-list'));return {blur:s.backdropFilter,background:s.backgroundColor}})()`,
  );
  assert.match(style.blur, /blur/);
  assert.match(style.background, /rgba/);
  await screenshot('lists-light.png');
  if (exportCheck) {
    await click('[aria-label="Canvas options"]');
    const index = await read(
      `Array.from(document.querySelectorAll('.context-menu button')).findIndex(b=>b.textContent.trim()==='Export selected…')+1`,
    );
    assert.ok(index > 0);
    await click(`.context-menu button:nth-of-type(${index})`);
    await click('.export-formats button');
    await until(() => existsSync(join(root, 'list-export.png')), 'list PNG export');
    const sharp = require('sharp');
    const { data, info } = await sharp(join(root, 'list-export.png'))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let ink = 0,
      green = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i] < 100 && data[i + 1] < 110 && data[i + 2] < 120) ink++;
      if (data[i + 1] > data[i] + 15 && data[i + 1] > data[i + 2] + 8) green++;
    }
    assert.ok(ink > 80, 'export contains item text');
    assert.ok(green > 50, 'export contains checked circle');
  }
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }],
  });
  await read('window.__beforeListReload=true');
  await send('Page.reload');
  await until(
    () =>
      read(
        `!window.__beforeListReload && !document.getElementById('startup-screen') && document.querySelector('.canvas-list-name')?.value==='Weekend away'`,
      ),
    'reload saved list',
  );
  assert.equal(await read(`document.querySelectorAll('.canvas-list-row').length`), 2);
  assert.equal(
    await read(`getComputedStyle(document.querySelector('[aria-label="List name"]')).fontWeight`),
    '700',
    'title bold survives reload',
  );
  assert.equal(
    await read(
      `getComputedStyle(document.querySelector('[aria-label="List name"]')).textDecorationLine`,
    ),
    'line-through',
    'title strike survives reload',
  );
  assert.equal(
    await read(`document.querySelector('.canvas-list-circle').getAttribute('aria-checked')`),
    'true',
  );
  await screenshot('lists-dark.png');
  assert.equal(
    await read(`!!document.querySelector('[aria-label="Add list item"]')`),
    false,
    'reopen starts in read mode',
  );
  await doubleClick('.canvas-list-header');
  await click('[aria-label="Add list item"]');
  await until(
    () => read(`document.activeElement?.getAttribute('aria-label')==='List item 3'`),
    'new empty row focus',
  );
  await key('Backspace');
  await until(
    () => read(`document.querySelectorAll('.canvas-list-row').length===2`),
    'remove empty row',
  );
  await click('[aria-label="Remove item 2"]');
  await until(async () => (await state()).objects[0].items.length === 1, 'remove item saves');
  await click('[aria-label="Insert"]');
  await click('.insert-menu [aria-label="Add list"]');
  await until(() => read(`document.querySelectorAll('.canvas-list').length===2`), 'second list');
  await doubleClick('.canvas-list:last-child .canvas-list-header');
  await click('.canvas-list:last-child [aria-label="Remove item 2"]');
  await click('.canvas-list:last-child [aria-label="Remove item 1"]');
  await click('.canvas-list:last-child [aria-label="Add list item"]');
  await until(
    () =>
      read(
        `document.activeElement?.closest('.canvas-list')===document.querySelector('.canvas-list:last-child') && document.activeElement?.tagName==='INPUT'`,
      ),
    'empty list row focus',
  );
  await key('Backspace');
  await until(
    () =>
      read(
        `document.querySelectorAll('.canvas-list').length===2 && document.querySelectorAll('.canvas-list:last-child .canvas-list-row').length===0`,
      ),
    'removing final empty row keeps its list',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: 'LISTS_DESKTOP_OK',
      root,
      style,
      checks: [
        'double-click editing',
        'wavy border with stable content',
        'reduced motion',
        'outside click and Escape',
        'icon-only',
        'add',
        'inline typing',
        'enter',
        'toggle twice',
        'rename',
        'drag',
        'undo',
        'redo',
        'zoom',
        'glass',
        'reload',
        'light/dark',
        'delete',
      ],
    }),
  );
} catch (error) {
  console.error(error);
  if (socket) {
    try {
      await screenshot('failure.png');
      console.error(await read('document.body.innerText'));
    } catch {}
  }
  console.error('Library:', root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
