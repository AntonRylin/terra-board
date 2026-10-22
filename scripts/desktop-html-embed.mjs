// HTML embeds in the desktop app: the board captures a picture of each, a
// double-click runs the page sandboxed over the board, and code edits capture a
// new picture. Embeds on screen show their running page under the board, which
// draws over it; resting the pointer lets it through, unless the embed waits for
// a double-click. TERRA_SOURCE_CHECK=1 runs the built source instead of the
// package.
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { snapshotKey } from '../src/canvas/html-card.ts';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');

const page = `<!doctype html><html><head><style>
body{margin:0;height:100vh;display:grid;place-items:center;background:#2f6fed;font:24px sans-serif}
#count{font:inherit;padding:16px 28px}
</style></head><body><button id="count">0</button><script>
const b = document.getElementById('count');
b.onclick = () => { b.textContent = String(+b.textContent + 1); };
const facts = {
  bridge: typeof window.canvas,
  width: innerWidth,
  height: innerHeight,
  parent: (() => { try { return String(!!parent.document); } catch { return 'blocked'; } })(),
  storage: (() => { try { localStorage.length; return 'open'; } catch { return 'blocked'; } })(),
};
fetch('canvas-media://asset/${'a'.repeat(64)}/preview')
  .then(() => 'open', () => 'blocked')
  .then((media) => { document.body.dataset.facts = JSON.stringify({ ...facts, media }); });
</script></body></html>`;

const hoverPage = `<!doctype html><html><head><style>
body{margin:0;height:100vh}
#box{height:300%;background:#ddd}
#box:hover{background:#e4572e}
</style></head><body><div id="box"></div></body></html>`;
const plainPage = `<!doctype html><html><head><style>
body{margin:0;height:100vh;display:grid;place-items:center;font:28px Georgia,serif;color:#1f2328}
</style></head><body><p id="plain">Hola, ¿qué tal?</p></body></html>`;

mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-html-embed-'));
const store = new Store(root);
const board = store.createBoard({ name: 'HTML embeds' });
store.patchBoard({
  id: board.id,
  revision: 0,
  upserts: [
    {
      id: 'embed',
      type: 'html',
      x: 100,
      y: 120,
      width: 480,
      height: 320,
      z: 1,
      html: page,
      hoverLive: false,
    },
    { id: 'hover', type: 'html', x: 100, y: 480, width: 300, height: 160, z: 2, html: hoverPage },
    { id: 'plain', type: 'html', x: 440, y: 480, width: 260, height: 160, z: 3, html: plainPage },
  ],
  camera: { x: 0, y: 0, zoom: 1 },
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
const child = spawn(
  source
    ? require('electron')
    : resolve(process.env.TERRA_TEST_EXE || 'release/win-unpacked/Terra Board.exe'),
  [
    ...(source ? [resolve('.')] : []),
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
    await sleep(80);
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
async function read(expression, contextId) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...(contextId ? { contextId } : {}),
  });
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
  for (let c = 1; c <= count; c++) {
    await mouse('mousePressed', x, y, 1, c);
    await mouse('mouseReleased', x, y, 0, c);
  }
}
async function click(selector) {
  const r = await until(() => rect(selector), selector);
  await clickAt(r.x + r.width / 2, r.y + r.height / 2);
}
const key = async (key, code = key, modifiers = 0, windowsVirtualKeyCode) => {
  for (const type of ['keyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode });
};
const state = () => read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`);
const embed = async () => (await state()).objects.find((o) => o.id === 'embed');
const screenshot = async (name) =>
  writeFileSync(
    join(root, name),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
// The card's center on screen, from the board camera and the canvas position.
const cardCenter = () =>
  read(`(async()=>{
    const d = await window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}});
    const o = d.objects.find((o) => o.id === 'embed'), c = d.camera;
    const r = document.querySelector('.canvas-surface').getBoundingClientRect();
    return { x: r.left + (o.x + o.width / 2) * c.zoom + c.x, y: r.top + (o.y + o.height / 2) * c.zoom + c.y };
  })()`);
// Running pages are out of process (their own origin): evaluate in each page
// frame's target, and take the first answer. Hover pages load ahead of the
// pointer, so several may run at once.
async function frameRead(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  for (const frame of targets.filter(
    (t) => t.type === 'iframe' && t.url.startsWith('terra-html://'),
  )) {
    const value = await frameEvaluate(frame, expression).catch(() => null);
    if (value) return value;
  }
  return null;
}
async function frameEvaluate(frame, expression) {
  const ws = new WebSocket(frame.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  try {
    const reply = new Promise((r) =>
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id === 1) r(m);
      }),
    );
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
      }),
    );
    const m = await reply;
    return m.result?.result?.value ?? null;
  } finally {
    ws.close();
  }
}
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
  await send('Page.enable');
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

  // 1. Opening the board captures a picture at twice the card's CSS size.
  const captured = await until(async () => {
    const o = await embed();
    return o.assetId && o.snapshotKey ? o : null;
  }, 'first picture');
  assert.equal(captured.snapshotKey, snapshotKey(captured));
  assert.deepEqual(
    await read(`window.canvas.assetDimensions(${JSON.stringify(captured.assetId)})`),
    {
      width: 960,
      height: 640,
    },
  );
  await sleep(500);
  await screenshot('1-picture.png');

  // 2. A double-click runs the page over the board, sandboxed.
  const center = await cardCenter();
  await clickAt(center.x, center.y, 2);
  await until(
    () => read(`!!document.querySelector('.board-html-live iframe[src^="terra-html://"]')`),
    'live frame',
  );
  const facts = JSON.parse(
    // Two copies of this page run now (on the board, and over it); a frame the
    // browser has not sized yet reads 0x0 when its script runs.
    await until(
      () =>
        frameRead(
          `(() => { const f = document.body.dataset.facts; return f && JSON.parse(f).width ? f : ''; })()`,
        ),
      'page facts',
    ),
  );
  assert.deepEqual(facts, {
    bridge: 'undefined',
    width: 480,
    height: 320,
    parent: 'blocked',
    storage: 'blocked',
    media: 'blocked',
  });
  await clickAt(center.x, center.y);
  await clickAt(center.x, center.y);
  await until(
    async () =>
      (await frameRead(`document.getElementById('count')?.textContent === '2' || null`)) === true,
    'clicks reach the page',
  );
  await screenshot('2-live.png');

  // 3. Editing the code saves it and captures a new picture.
  await click('.selection-tools [aria-label="Edit code"]');
  await until(() => read(`!document.querySelector('.board-html-live')`), 'live stops for editing');
  await until(() => read(`!!document.querySelector('.html-editor textarea')`), 'editor');
  await until(
    () => read(`!!document.querySelector('.html-editor-preview iframe[src^="terra-html://"]')`),
    'editor preview',
  );
  await read(`(()=>{
    const t = document.querySelector('.html-editor textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(t, t.value.replace('#2f6fed', '#16a34a'));
    t.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(600);
  await screenshot('3-editor.png');
  await click('.html-editor .button.primary');
  await until(() => read(`!document.querySelector('.html-editor')`), 'editor closes');
  const edited = await until(async () => {
    const o = await embed();
    return o.html.includes('#16a34a') &&
      o.assetId !== captured.assetId &&
      snapshotKey(o) === o.snapshotKey
      ? o
      : null;
  }, 'edited picture');
  await sleep(500);
  await screenshot('4-edited.png');

  // 4. Undo restores the earlier code with its own picture, without a capture.
  await click('.canvas-surface canvas');
  await key('z', 'KeyZ', 2, 90);
  const undone = await until(async () => {
    const o = await embed();
    return o.html.includes('#2f6fed') ? o : null;
  }, 'undo');
  assert.equal(undone.assetId, captured.assetId);
  assert.equal(undone.snapshotKey, captured.snapshotKey);

  // 5. Clicking the board stops a running page.
  await clickAt(center.x, center.y, 2);
  await until(() => read(`!!document.querySelector('.board-html-live')`), 'live again');
  // A right-drag over a running page pans the board, and the page keeps running.
  for (const [dx, dy] of [
    [60, 40],
    [-60, -40],
  ]) {
    const live = await until(() => rect('.board-html-live[data-ready]'), 'running page ready');
    await sleep(300);
    const from = { x: live.x + 20, y: live.y + 20 };
    const right = (type, x, y, buttons) =>
      send('Input.dispatchMouseEvent', { type, x, y, button: 'right', buttons, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await right('mousePressed', from.x, from.y, 2);
    for (let i = 1; i <= 6; i++) {
      await sleep(30);
      await right('mouseMoved', from.x + (dx * i) / 6, from.y + (dy * i) / 6, 2);
    }
    await right('mouseReleased', from.x + dx, from.y + dy, 0);
    await until(async () => {
      const now = await rect('.board-html-live');
      return now && Math.abs(now.x - live.x - dx) < 4 && Math.abs(now.y - live.y - dy) < 4;
    }, 'right-drag pans the board over a running page');
    await sleep(600);
    assert.equal(await read(`!!document.querySelector('.context-menu')`), false, 'no menu');
  }
  await clickAt(center.x + 400, center.y + 300);
  await until(() => read(`!document.querySelector('.board-html-live')`), 'live stops');

  // 6. Resting the pointer on an embed runs it, and the page sees the hover.
  await until(async () => {
    const o = (await state()).objects.find((o) => o.id === 'hover');
    return o.assetId && o.snapshotKey === snapshotKey(o);
  }, 'hover picture');
  // An embed's box on screen, from the board camera and the canvas position.
  const embedBox = (id) =>
    read(`(async()=>{
      const d = await window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}});
      const o = d.objects.find((o) => o.id === ${JSON.stringify(id)}), c = d.camera;
      const r = document.querySelector('.canvas-surface').getBoundingClientRect();
      return { x: r.left + o.x * c.zoom + c.x, y: r.top + o.y * c.zoom + c.y, width: o.width * c.zoom, height: o.height * c.zoom };
    })()`);
  const clip = async (b) =>
    Buffer.from(
      (
        await send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: b.x + 3, y: b.y + 3, width: b.width - 6, height: b.height - 6, scale: 1 },
        })
      ).data,
      'base64',
    );
  // Embeds on screen show their running page rather than a picture of it, so
  // resting the pointer on one changes nothing on screen.
  await until(
    async () =>
      (await frameRead(`document.getElementById('plain') ? 'loaded' : null`)) === 'loaded',
    'pages run on the board',
  );
  const plain = await embedBox('plain');
  await mouse('mouseMoved', plain.x + plain.width + 150, plain.y + plain.height / 2);
  await sleep(500);
  const away = await clip(plain);
  await mouse('mouseMoved', plain.x + plain.width / 2, plain.y + plain.height / 2);
  await until(() => read(`!!document.querySelector('.board-page[data-shown]')`), 'plain hover');
  await sleep(300);
  assert.ok(away.equals(await clip(plain)), 'resting the pointer changes nothing on screen');
  await frameRead(
    `document.getElementById('plain') ? ((document.getElementById('plain').textContent = 'LIVE'), true) : null`,
  );
  await sleep(300);
  assert.ok(!away.equals(await clip(plain)), 'the board shows the running page');
  // The board draws over the page: the embed's border line shows along its top.
  {
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: plain.x + 20, y: plain.y - 3, width: 120, height: 6, scale: 1 },
    });
    const { data, info } = await sharp(Buffer.from(shot.data, 'base64'))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const lineRows = Array.from({ length: info.height }, (_, row) => {
      let dark = 0;
      for (let x = 0; x < info.width; x++) {
        const i = (row * info.width + x) * 3;
        if ((data[i] + data[i + 1] + data[i + 2]) / 3 < 240) dark++;
      }
      return dark / info.width;
    });
    assert.ok(Math.max(...lineRows) > 0.8, 'border drawn over the page: ' + lineRows.join(','));
  }
  await screenshot('5-live-pages.png');

  // 7. Resting the pointer on an embed lets it through, and the page sees the hover.
  const hover = await embedBox('hover');
  let at = { x: hover.x + hover.width / 2, y: hover.y + hover.height / 2 };
  // Across the gap from the other embed and on over this one, as a mouse moves
  // (a move every 8 ms, nothing waiting in between). The pointer passes to each
  // page once: off the first, onto the second, with no flicker between.
  await read(`(() => {
    window.hoverChanges = 0;
    new MutationObserver((m) => { window.hoverChanges += m.length; }).observe(
      document.querySelector('.canvas-surface'),
      { attributes: true, attributeFilter: ['data-page-hover'] },
    );
  })()`);
  const from = { x: plain.x + plain.width / 2, y: plain.y + plain.height / 2 };
  for (let i = 1; i <= 12; i++) {
    await mouse(
      'mouseMoved',
      from.x + ((at.x - from.x) * i) / 12,
      from.y + ((at.y - from.y) * i) / 12,
    );
    await sleep(8);
  }
  for (let i = 1; i <= 20; i++) {
    await mouse('mouseMoved', at.x - 60 + i * 6, at.y + Math.sin(i) * 20);
    await sleep(8);
  }
  assert.ok(await read(`!!document.querySelector('.board-page[data-shown]')`), 'hover');
  // A real mouse reports faster than a page takes the pointer: moves that still
  // reach the board, moves the browser addresses to the page's frame element as
  // the pointer enters it, and the page reporting the pointer gone, while it is
  // on the embed, keep the page under it.
  assert.ok(
    await read(`(() => {
      const host = document.querySelector('.canvas-surface');
      const page = document.querySelector('.board-page[data-shown]');
      const at = { clientX: ${at.x}, clientY: ${at.y}, bubbles: true, pointerType: 'mouse' };
      host.dispatchEvent(new PointerEvent('pointermove', at));
      page.querySelector('iframe').dispatchEvent(new PointerEvent('pointermove', at));
      page.dispatchEvent(new PointerEvent('pointerleave', { ...at, bubbles: false }));
      host.dispatchEvent(new PointerEvent('pointermove', at));
      return page.hasAttribute('data-shown') && host.hasAttribute('data-page-hover');
    })()`),
    'the hand-over keeps the page under the pointer',
  );
  const hoverChanges = await read('window.hoverChanges');
  assert.ok(hoverChanges <= 3, `the pointer passed to the page in one go: ${hoverChanges} changes`);
  for (let i = 1; i <= 4; i++) {
    await sleep(30);
    await mouse('mouseMoved', at.x + 2 + i, at.y + 2);
  }
  await until(
    async () => (await frameRead(`document.getElementById('box')?.matches(':hover')`)) === true,
    'the page sees the pointer',
  );
  await screenshot('5-hover.png');

  // 8. A wheel turn zooms the board, even over a page that could scroll.
  const before = await rect('.board-page[data-shown]');
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: at.x + 4,
    y: at.y + 2,
    deltaX: 0,
    deltaY: -100,
  });
  await until(
    async () => ((await rect('.board-page[data-shown]'))?.width || 0) > before.width + 1,
    'wheel zooms the board',
  );
  assert.equal(
    await frameRead(`document.getElementById('box') ? String(scrollY) : ''`),
    '0',
    'the hovered page did not scroll',
  );

  // A page with its own wheel handling (a map's zoom, say) keeps the wheel.
  assert.equal(
    await frameRead(
      `document.getElementById('box') ? (document.getElementById('box').addEventListener('wheel', (e) => { e.preventDefault(); window.ownWheel = (window.ownWheel || 0) + 1; }, { passive: false }), 'on') : ''`,
    ),
    'on',
  );
  // The first turn's zoom eases in; let it finish.
  await sleep(800);
  const zoomed = await rect('.board-page[data-shown]');
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: at.x + 4,
    y: at.y + 2,
    deltaX: 0,
    deltaY: -100,
  });
  await until(
    async () => Number(await frameRead(`String(window.ownWheel || '')`)) >= 1,
    'the page handles its own wheel',
  );
  await sleep(400);
  assert.ok(
    Math.abs((await rect('.board-page[data-shown]')).width - zoomed.width) < 1,
    'the board did not zoom over a page that handles the wheel',
  );

  // 8b. Other buttons work as over the board unless the page takes them.
  const press = async (type, button, x, y, buttons) =>
    send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: 1 });
  const buttonMask = { left: 1, right: 2, middle: 4 };
  async function dragOnPage(button, dx, dy) {
    const box = await until(() => rect('.board-page[data-shown]'), 'hover page shown');
    const from = { x: box.x + 30, y: box.y + 30 };
    await press('mouseMoved', 'none', from.x, from.y, 0);
    await press('mousePressed', button, from.x, from.y, buttonMask[button]);
    for (let i = 1; i <= 6; i++) {
      await sleep(30);
      await press(
        'mouseMoved',
        button,
        from.x + (dx * i) / 6,
        from.y + (dy * i) / 6,
        buttonMask[button],
      );
    }
    await press('mouseReleased', button, from.x + dx, from.y + dy, 0);
    await sleep(300);
    // The page takes the pointer back on the next move, as after any drag.
    for (let i = 1; i <= 4; i++) {
      await sleep(30);
      await press('mouseMoved', 'none', from.x + dx + i, from.y + dy, 0);
    }
    const after = await until(() => rect('.board-page[data-shown]'), 'hover after drag');
    return { x: after.x - box.x, y: after.y - box.y, to: { x: from.x + dx, y: from.y + dy } };
  }
  const menuOpen = () => read(`!!document.querySelector('.context-menu')`);
  // Right-drag pans the board with the page under the pointer.
  let moved = await dragOnPage('right', 60, 40);
  assert.ok(
    Math.abs(moved.x - 60) < 4 && Math.abs(moved.y - 40) < 4,
    `right-drag pans: ${JSON.stringify(moved)}`,
  );
  assert.equal(await menuOpen(), false, 'no menu after a right-drag');
  // So does a middle-drag.
  moved = await dragOnPage('middle', -50, -30);
  assert.ok(
    Math.abs(moved.x + 50) < 4 && Math.abs(moved.y + 30) < 4,
    `middle-drag pans: ${JSON.stringify(moved)}`,
  );
  // A right-click opens the board's menu.
  let spot = await rect('.board-page[data-shown]');
  await press('mousePressed', 'right', spot.x + 30, spot.y + 30, 2);
  await press('mouseReleased', 'right', spot.x + 30, spot.y + 30, 0);
  await until(menuOpen, 'right-click opens the board menu');
  await key('Escape');
  await until(async () => !(await menuOpen()), 'menu closes');
  // Clear the selection the menu made, and rest on the page again.
  await key('Escape');
  await until(
    async () => (await read(`document.querySelectorAll('.selection-tools').length`)) === 0,
    'selection cleared',
  );
  // The camera has not moved since, so the page is still where it was.
  for (let i = 0; i <= 5; i++) {
    await sleep(30);
    await press('mouseMoved', 'none', spot.x + 40 + i, spot.y + 40, 0);
  }
  await until(() => read(`!!document.querySelector('.board-page[data-shown]')`), 'hover again');
  // A page with its own right-click menu keeps the right-click.
  assert.equal(
    await frameRead(
      `document.getElementById('box') ? (addEventListener('contextmenu', (e) => { e.preventDefault(); window.ownMenu = (window.ownMenu || 0) + 1; }), 'on') : ''`,
    ),
    'on',
  );
  spot = await rect('.board-page[data-shown]');
  await press('mousePressed', 'right', spot.x + 30, spot.y + 30, 2);
  await press('mouseReleased', 'right', spot.x + 30, spot.y + 30, 0);
  await until(
    async () => Number(await frameRead(`String(window.ownMenu || '')`)) >= 1,
    'the page shows its own menu',
  );
  await sleep(600);
  assert.equal(await menuOpen(), false, 'no board menu over a page with its own');
  // A page that takes the right button for itself is not panned.
  assert.equal(
    await frameRead(
      `document.getElementById('box') ? (addEventListener('mousedown', (e) => { if (e.button === 2) e.preventDefault(); }), 'on') : ''`,
    ),
    'on',
  );
  moved = await dragOnPage('right', 60, 40);
  assert.ok(
    Math.abs(moved.x) < 2 && Math.abs(moved.y) < 2,
    `page kept its right-drag: ${JSON.stringify(moved)}`,
  );

  // A left-drag away from the page's controls moves the embed, like any object.
  const hoverBefore = (await state()).objects.find((o) => o.id === 'hover');
  spot = await rect('.board-page[data-shown]');
  const grab = { x: spot.x + 50, y: spot.y + 50 };
  await press('mousePressed', 'left', grab.x, grab.y, 1);
  for (let i = 1; i <= 6; i++) {
    await sleep(30);
    await press('mouseMoved', 'left', grab.x + (40 * i) / 6, grab.y, 1);
  }
  await press('mouseReleased', 'left', grab.x + 40, grab.y, 0);
  await until(async () => {
    const o = (await state()).objects.find((o) => o.id === 'hover');
    // Snapping to nearby edges may shift it a little.
    return (
      o.x - hoverBefore.x > 25 && o.x - hoverBefore.x < 50 && Math.abs(o.y - hoverBefore.y) < 3
    );
  }, 'left-drag moves the embed');
  await key('Escape');
  await until(
    async () => (await read(`document.querySelectorAll('.selection-tools').length`)) === 0,
    'selection cleared after the move',
  );
  for (let i = 0; i <= 5; i++) {
    await sleep(30);
    await press('mouseMoved', 'none', grab.x + 40 + i, grab.y, 0);
  }
  await until(
    () => read(`!!document.querySelector('.board-page[data-shown]')`),
    'hover after move',
  );

  // 9. Pressing the page away from controls selects the embed and shows its picture.
  const live = await rect('.board-page[data-shown]');
  at = { x: live.x + live.width / 2, y: live.y + live.height / 2 };
  await clickAt(at.x, at.y);
  await until(() => read(`!document.querySelector('.board-page[data-shown]')`), 'press selects');
  await until(
    () =>
      read(
        `document.querySelector('.selection-tools [aria-label="Run on hover"]')?.getAttribute('aria-pressed') === 'true'`,
      ),
    'hover setting shown',
  );

  // 10. Turned off, the embed waits for a double-click.
  // The toolbar settles in after a selection.
  await sleep(400);
  await click('.selection-tools [aria-label="Run on hover"]');
  await until(
    async () => (await state()).objects.find((o) => o.id === 'hover').hoverLive === false,
    'hover off saved',
  );
  await key('Escape', 'Escape', 0, 27);
  await until(() => read(`!document.querySelector('.selection-tools')`), 'deselected');
  await mouse('mouseMoved', at.x + 600, at.y);
  await mouse('mouseMoved', at.x, at.y);
  await mouse('mouseMoved', at.x + 2, at.y);
  await sleep(600);
  assert.equal(await read(`!!document.querySelector('.board-page[data-shown]')`), false);

  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ root, picture: captured.assetId, edited: edited.assetId, facts }, null, 2),
  );
} catch (error) {
  console.error(error);
  try {
    console.error(
      'OVERLAYS',
      await read(
        `JSON.stringify([...document.querySelectorAll('.board-html-live,.board-page')].map(e=>({a:[...e.attributes].map(x=>x.name+'='+x.value.slice(0,140)).join(' '), vis:getComputedStyle(e).visibility, op:getComputedStyle(e).opacity, pe:getComputedStyle(e).pointerEvents})))`,
      ),
    );
  } catch {}
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
