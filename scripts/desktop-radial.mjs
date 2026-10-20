import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-radial-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Quick tools' });
store.setLastBoard({ id: board.id });
store.saveCamera({ id: board.id, camera: { x: 45, y: -30, zoom: 1.4 } });
store.close();
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const env = { ...process.env, CANVAS_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const source = !!process.env.TERRA_SOURCE_CHECK;
const child = spawn(
  source
    ? require('electron')
    : resolve(process.env.TERRA_TEST_EXE || 'release/win-unpacked/Terra Board.exe'),
  [...(source ? [resolve('.')] : []), `--remote-debugging-port=${port}`],
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
async function mouse(type, x, y, buttons = 0, modifiers = 0) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: type === 'mouseMoved' && !buttons ? 'none' : 'left',
    buttons,
    clickCount: 1,
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
const keyEvent = async (type, key, code = key, modifiers = 0) => {
  const windowsVirtualKeyCode =
    { Tab: 9, Enter: 13, Escape: 27, ArrowLeft: 37 }[key] || key.toUpperCase().charCodeAt(0);
  await send('Input.dispatchKeyEvent', {
    type,
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
  });
};
const key = async (k, code = k, modifiers = 0) => {
  await keyEvent('keyDown', k, code, modifiers);
  await keyEvent('keyUp', k, code, modifiers);
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
    60000,
  );
  await until(
    () =>
      read(
        "!document.querySelector('#startup-screen') && !!document.querySelector('.canvas-toolbar')",
      ),
    'ready',
    60000,
  );
  const surface = await rect('.canvas-surface');
  const origin = { x: surface.x + surface.width * 0.55, y: surface.y + surface.height * 0.45 };
  const wheel = () => read("!!document.querySelector('.radial-menu')");
  const focusBoard = () => read("document.querySelector('.canvas-surface').focus()");
  // A tap of the trigger leaves the wheel open for click or keyboard selection.
  const open = async (point = origin) => {
    await focusBoard();
    await mouse('mouseMoved', point.x, point.y);
    await key('Tab');
    await until(wheel, 'radial menu');
  };
  const center = async (selector) => {
    const r = await until(() => rect(selector), selector);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  // Holding the trigger, moving onto a tool and releasing selects it.
  const holdSelect = async (tool, point = origin) => {
    await focusBoard();
    await mouse('mouseMoved', point.x, point.y);
    await keyEvent('keyDown', 'Tab');
    await until(wheel, 'radial menu');
    const p = await center(`[data-radial-tool="${tool}"]`);
    await mouse('mouseMoved', p.x, p.y);
    await keyEvent('keyUp', 'Tab');
    await until(async () => !(await wheel()), `release selects ${tool}`);
  };
  const clickAt = async (point) => {
    await mouse('mousePressed', point.x, point.y, 1);
    await mouse('mouseReleased', point.x, point.y);
  };
  const objects = async () => (await state()).objects;
  await focusBoard();
  await mouse('mouseMoved', origin.x, origin.y);
  await keyEvent('keyDown', 'Tab');
  await until(wheel, 'radial menu');
  const menuBounds = await rect('.radial-menu');
  assert.ok(
    Math.abs(menuBounds.x + menuBounds.width / 2 - origin.x) < 2 &&
      Math.abs(menuBounds.y + menuBounds.height / 2 - origin.y) < 2,
    'wheel is centered on the cursor',
  );
  assert.equal(Math.round(menuBounds.width), 280, 'wheel keeps its compact size');
  assert.equal(
    await read("getComputedStyle(document.querySelector('.radial-backdrop')).backgroundColor"),
    'rgba(0, 0, 0, 0)',
    'board is not washed out behind the wheel',
  );
  await screenshot('radial-light.png');
  const arrowSlot = await center('[data-radial-tool="arrow"]');
  await mouse('mouseMoved', arrowSlot.x, arrowSlot.y);
  assert.equal(await wheel(), true, 'hovering a tool does not select it');
  await keyEvent('keyUp', 'Tab');
  await until(async () => !(await wheel()), 'release selects arrow');
  assert.equal((await objects()).length, 0, 'draft is not saved');
  const end = { x: origin.x + 165, y: origin.y + 95 };
  await mouse('mouseMoved', end.x, end.y);
  assert.equal(
    await read("!!document.querySelector('.selection-tools')"),
    false,
    'draft has no saved-object toolbar',
  );
  await screenshot('arrow-preview.png');
  await clickAt(end);
  const first = await until(
    async () => (await objects()).find((o) => o.type === 'arrow'),
    'saved arrow',
  );
  const camera = (await state()).camera;
  // Initial fixture camera is measured from storage rather than assumed.
  const cameraValue = typeof camera === 'string' ? JSON.parse(camera) : camera;
  const c = cameraValue || { x: 0, y: 0, zoom: 1 };
  const points = first.arrow?.points;
  assert.ok(points?.length >= 2, 'arrow endpoints persisted');
  const start = { x: first.x + points[0].x * first.width, y: first.y + points[0].y * first.height };
  assert.ok(Math.abs(start.x * c.zoom + c.x + surface.x - origin.x) < 2, 'original anchor x');
  assert.ok(Math.abs(start.y * c.zoom + c.y + surface.y - origin.y) < 2, 'original anchor y');
  await key('z', 'KeyZ', 2);
  await until(async () => (await objects()).length === 0, 'one-step undo');
  await key('y', 'KeyY', 2);
  await until(async () => (await objects()).length === 1, 'redo');
  await key('Escape');
  await open();
  await mouse('mouseMoved', origin.x - 95, origin.y);
  await key('Escape');
  assert.equal((await objects()).length, 1, 'cancel leaves only committed arrow');
  await focusBoard();
  await mouse('mouseMoved', origin.x, origin.y);
  await keyEvent('keyDown', 'Tab');
  await until(wheel, 'radial menu');
  const corridor = await center('.radial-settings');
  await mouse('mouseMoved', corridor.x, corridor.y);
  await keyEvent('keyUp', 'Tab');
  assert.equal(await wheel(), true, 'settings corridor does not select a tool');
  await click('.radial-settings');
  await until(() => read("!!document.querySelector('.radial-palette')"), 'customization');
  await click('[data-radial-slot="5"]');
  await click('.radial-choices button:nth-child(10)');
  assert.equal(
    await read("JSON.parse(localStorage.getItem('terra-board.preferences')).radial[5]"),
    'list',
  );
  await screenshot('radial-customization.png');
  await key('Tab');
  assert.equal(
    await read("!!document.activeElement.closest('.radial-menu')"),
    true,
    'focus stays in customization',
  );
  await key('Escape');
  const timeOrigin = await read('performance.timeOrigin');
  await send('Page.reload');
  await until(async () => {
    try {
      return await read(
        `performance.timeOrigin !== ${timeOrigin} && !document.querySelector('#startup-screen') && !document.querySelector('.canvas-loading') && !!document.querySelector('.canvas-surface canvas') && !!document.querySelector('.canvas-toolbar')`,
      );
    } catch {
      return false;
    }
  }, 'reload');
  await open();
  assert.equal(
    await read('document.querySelector(\'[data-radial-slot="5"]\').dataset.radialTool'),
    'list',
  );
  await click('[data-radial-slot="5"]');
  const list = await until(
    async () => (await objects()).find((o) => o.type === 'list'),
    'custom tool action',
  );
  assert.ok(
    Math.abs(list.x * c.zoom + c.x + surface.x - origin.x) < 2,
    'list uses original anchor',
  );
  await key('Escape');
  await open();
  await click('.radial-settings');
  await click('.radial-reset');
  await key('Escape');
  await holdSelect('text');
  await until(
    () =>
      read(
        "!!document.activeElement && (document.activeElement.isContentEditable || document.activeElement.tagName === 'TEXTAREA')",
      ),
    'text editor',
  );
  await key('Tab');
  assert.equal(await wheel(), false, 'Tab does not open wheel while editing');
  await key('Escape');
  await read("document.documentElement.dataset.theme='dark'");
  await open();
  await screenshot('radial-dark.png');
  await key('Escape');
  const edge = { x: surface.x + surface.width - 25, y: surface.y + 110 };
  await open(edge);
  const bounds = await rect('.radial-menu');
  const screen = await read('({ w: innerWidth, h: innerHeight })');
  assert.ok(
    bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= screen.w &&
      bounds.y + bounds.height <= screen.h,
    'wheel near an edge stays fully on screen',
  );
  await key('ArrowLeft');
  assert.equal(
    await read('document.activeElement.dataset.radialTool'),
    'arrow',
    'keyboard focuses arrow',
  );
  await key('Enter');
  await until(async () => !(await wheel()), 'keyboard activates arrow');
  await mouse('mouseMoved', edge.x - 180, edge.y + 150);
  await clickAt({ x: edge.x - 180, y: edge.y + 150 });
  await until(
    async () => (await objects()).filter((o) => o.type === 'arrow').length === 2,
    'edge arrow',
  );
  const edgeArrow = (await objects())
    .filter((o) => o.type === 'arrow')
    .find((o) => o.id !== first.id);
  const edgeStart = edgeArrow.arrow.points[0];
  assert.ok(
    Math.abs((edgeArrow.x + edgeStart.x * edgeArrow.width) * c.zoom + c.x + surface.x - edge.x) < 2,
    'nudged wheel preserves original anchor at the edge',
  );
  await key('Escape');
  await open();
  await key('ArrowLeft');
  await key(' ', 'Space');
  await until(async () => !(await wheel()), 'Space activates focused tool');
  await key('n', 'KeyN');
  assert.equal(
    await read("document.querySelector('.canvas-surface').classList.contains('tool-note')"),
    true,
    'tool switch preserves requested UI state',
  );
  assert.equal(
    (await objects()).filter((o) => o.type === 'arrow').length,
    2,
    'tool switch discards unfinished arrow',
  );
  await key('Escape');
  await open();
  await key('ArrowDown');
  await key('Enter');
  await until(
    () => read("!!document.querySelector('.radial-palette')"),
    'keyboard opens customization',
  );
  await key('Escape');
  assert.deepEqual(errors, []);
  for (const [modifier, code, mask, expectedAxis] of [
    ['Shift', 'ShiftLeft', 8, 'horizontal'],
    ['Control', 'ControlLeft', 2, 'vertical'],
  ]) {
    const before = new Set((await objects()).map((o) => o.id));
    await holdSelect('arrow');
    const target = { x: origin.x - 180, y: origin.y + 110 };
    await mouse('mouseMoved', target.x, target.y);
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: modifier,
      code,
      modifiers: mask,
      windowsVirtualKeyCode: mask === 8 ? 16 : 17,
    });
    await screenshot(`arrow-${expectedAxis}.png`);
    await mouse('mousePressed', target.x, target.y, 1, mask);
    await mouse('mouseReleased', target.x, target.y, 0, mask);
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: modifier,
      code,
      modifiers: 0,
      windowsVirtualKeyCode: mask === 8 ? 16 : 17,
    });
    const arrow = await until(
      async () => (await objects()).find((o) => !before.has(o.id) && o.type === 'arrow'),
      expectedAxis + ' arrow',
    );
    const [a, b] = arrow.arrow.points.map((p) => ({
      x: arrow.x + p.x * arrow.width,
      y: arrow.y + p.y * arrow.height,
    }));
    assert.ok(
      Math.abs(expectedAxis === 'horizontal' ? a.y - b.y : a.x - b.x) < 0.001,
      expectedAxis + ' alignment persists',
    );
    assert.ok(
      Math.abs(expectedAxis === 'horizontal' ? a.x - b.x : a.y - b.y) > 50,
      'constrained arrow retains length',
    );
    await key('Escape');
  }
  const editOrigin = { x: surface.x + surface.width * 0.28, y: surface.y + surface.height * 0.72 };
  const idsBeforeEditArrow = new Set((await objects()).map((o) => o.id));
  await holdSelect('arrow', editOrigin);
  await mouse('mouseMoved', editOrigin.x + 150, editOrigin.y - 80);
  await clickAt({ x: editOrigin.x + 150, y: editOrigin.y - 80 });
  const editable = await until(
    async () => (await objects()).find((o) => !idsBeforeEditArrow.has(o.id) && o.type === 'arrow'),
    'arrow to edit',
  );
  const worldPoints = (o) =>
    o.arrow.points.map((p) => ({ x: o.x + p.x * o.width, y: o.y + p.y * o.height }));
  const originalPoints = worldPoints(editable);
  for (const [index, modifier, code, mask] of [
    [0, 'Shift', 'ShiftLeft', 8],
    [1, 'Control', 'ControlLeft', 2],
  ]) {
    const start = originalPoints[index];
    const p = { x: start.x * c.zoom + c.x + surface.x, y: start.y * c.zoom + c.y + surface.y };
    await mouse('mouseMoved', p.x, p.y);
    const held = (type) =>
      send('Input.dispatchKeyEvent', {
        type,
        key: modifier,
        code,
        modifiers: type === 'keyDown' ? mask : 0,
        windowsVirtualKeyCode: mask === 8 ? 16 : 17,
      });
    if (index === 0) await held('keyDown');
    await mouse('mousePressed', p.x, p.y, 1, index === 0 ? mask : 0);
    await mouse('mouseMoved', p.x - 45, p.y + 70, 1, index === 0 ? mask : 0);
    if (index === 1) await held('keyDown');
    await screenshot(`existing-arrow-${modifier}.png`);
    await mouse('mouseReleased', p.x - 45, p.y + 70, 0, mask);
    await held('keyUp');
    const axis = mask === 8 ? 'y' : 'x';
    await until(async () => {
      const current = (await objects()).find((o) => o.id === editable.id);
      const pts = worldPoints(current);
      return Math.abs(pts[index][axis] - originalPoints[1 - index][axis]) < 0.001;
    }, modifier + ' aligns existing endpoint');
    const fixed = worldPoints((await objects()).find((o) => o.id === editable.id))[1 - index];
    assert.ok(
      Math.hypot(fixed.x - originalPoints[1 - index].x, fixed.y - originalPoints[1 - index].y) <
        0.001,
      'opposite endpoint stays fixed',
    );
    await key('z', 'KeyZ', 2);
    await until(async () => {
      const pts = worldPoints((await objects()).find((o) => o.id === editable.id));
      return pts.every(
        (q, i) => Math.hypot(q.x - originalPoints[i].x, q.y - originalPoints[i].y) < 0.001,
      );
    }, 'undo endpoint alignment');
  }
  assert.deepEqual(errors, []);
  console.log(
    'RADIAL_DESKTOP_OK ' +
      JSON.stringify({
        root,
        checks: [
          'compact glass wheel on the cursor',
          'hover highlights without selecting',
          'release-to-select',
          'tap keeps the wheel open for clicks',
          'anchor',
          'hover preview',
          'click commit',
          'undo/redo',
          'cancel',
          'settings corridor',
          'customization',
          'reload persistence',
          'anchored list',
          'editing Tab',
          'light/dark',
          'keyboard selection',
          'Shift horizontal / Ctrl vertical arrows',
          'existing endpoints align with fixed opposite endpoint and undo',
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
