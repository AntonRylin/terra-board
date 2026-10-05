import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/desktop-selection-toolbar-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Object tools' });
store.patchBoard({
  id: board.id,
  revision: 0,
  deleted: [],
  camera: { x: 0, y: 0, zoom: 1 },
  upserts: [
    {
      id: 'text',
      type: 'text',
      x: 450,
      y: 220,
      width: 360,
      height: 80,
      z: 1,
      text: 'Make it yours',
      fontSize: 44,
      color: '#48678e',
    },
    {
      id: 'note',
      type: 'note',
      x: 450,
      y: 460,
      width: 220,
      height: 180,
      z: 2,
      text: 'A note',
      fontSize: 24,
      color: '#fff0b9',
    },
    {
      id: 'arrow',
      type: 'arrow',
      x: 850,
      y: 430,
      width: 240,
      height: 100,
      z: 3,
      color: '#48678e',
      arrow: {
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        line: 'straight',
        start: 'none',
        end: 'arrow',
        dash: 'solid',
        thickness: 2,
      },
    },
    {
      id: 'gallery',
      type: 'frame',
      x: 900,
      y: 600,
      width: 250,
      height: 180,
      z: 4,
      text: 'Gallery',
      gallery: { direction: 'right', gap: 16, size: 180 },
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
  let previous;
  const r = await until(async () => {
    const next = await rect(selector);
    const stable = next && JSON.stringify(previous) === JSON.stringify(next);
    previous = next;
    return stable && next;
  }, selector + ' settled');
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
  const windowsVirtualKeyCode = { Enter: 13, Tab: 9, Escape: 27, ' ': 32 }[key] || 0;
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
    text: key === 'Enter' ? '\r' : undefined,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
  });
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
        (target) => target.type === 'page' && target.url.startsWith('canvas-app:'),
      );
    } catch {}
  }, 'app target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      message.error
        ? request?.reject(Error(message.error.message))
        : request?.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown')
      errors.push(message.params.exceptionDetails);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const ready = () =>
    read(
      `!!document.querySelector('.canvas-surface canvas') && !document.querySelector('.canvas-loading') && !document.getElementById('startup-screen')`,
    );
  await until(ready, 'canvas ready');
  const at = async (x, y, count = 1) => {
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, 1, count);
    await mouse('mouseReleased', x, y, 0, count);
  };
  const choose = async (x, y) => {
    await key('Escape');
    await at(x, y);
    await until(() => rect('.selection-toolbar-content'), 'selected object');
    await read(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',
    );
  };

  const plus = '.selection-toolbar-plus';
  const slot = (id) => `.selection-toolbar-content [data-tool-id="${id}"]`;
  const zoneIds = (zone) =>
    read(
      `Array.from(document.querySelectorAll('.selection-toolbar-content [data-tool-zone="${zone}"] [data-tool-id]'),el=>el.dataset.toolId)`,
    );
  const stored = () =>
    read(`JSON.parse(localStorage.getItem('terra-board.selection-toolbar-layout')||'null')`);
  const center = async (selector) => {
    await read(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest',inline:'nearest'})`,
    );
    let previous;
    const r = await until(async () => {
      const next = await rect(selector),
        stable = next && JSON.stringify(next) === JSON.stringify(previous);
      previous = next;
      return stable && next;
    }, selector + ' settled');
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const frame = () => read('new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))');
  const moveTo = async (from, to) => {
    for (let i = 1; i <= 10; i++) {
      await mouse(
        'mouseMoved',
        from.x + ((to.x - from.x) * i) / 10,
        from.y + ((to.y - from.y) * i) / 10,
        1,
      );
      await frame();
    }
  };
  const begin = async (id) => {
    const p = await center(slot(id) + ' > button');
    await mouse('mousePressed', p.x, p.y, 1);
    await mouse('mouseMoved', p.x + 7, p.y, 1);
    await until(() => rect('.toolbar-held-icon'), 'drag avatar');
    await frame();
    return { x: p.x + 7, y: p.y };
  };
  const release = async (point) => {
    await mouse('mouseReleased', point.x, point.y);
    await until(async () => !(await rect('.toolbar-held-icon')), 'settled drag');
    await until(
      () => read(`document.getAnimations().every(a=>a.playState!=='running')`),
      'settled animation',
    );
  };
  const destination = async (zone, neighbor) => {
    if (neighbor) {
      const p = await center(slot(neighbor));
      return zone === 'bar' ? { x: p.x - 12, y: p.y } : { x: p.x, y: p.y - 10 };
    }
    const r = await rect(zone === 'bar' ? '.selection-toolbar-content' : '.selection-tool-menu');
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const drag = async (id, zone, neighbor) => {
    const from = await begin(id);
    const targetIndex = neighbor ? (await zoneIds(zone)).indexOf(neighbor) : 0;
    let to = await destination(zone, neighbor);
    await moveTo(from, to);
    if (neighbor) {
      await until(
        () => read(`document.getAnimations().every(a=>a.playState!=='running')`),
        'preview settled',
      );
      const targetId = (await zoneIds(zone))[targetIndex];
      const adjusted = await center(slot(targetId));
      await moveTo(to, adjusted);
      to = adjusted;
    }
    await release(to);
    assert.ok((await zoneIds(zone)).includes(id), `${id} dropped in ${zone}`);
  };
  const menuFits = () =>
    until(async () => {
      const r = await rect('.selection-tool-menu'),
        v = await read('[innerWidth,innerHeight]');
      return (
        r && r.x >= 7.5 && r.y >= 7.5 && r.x + r.width <= v[0] - 7.5 && r.y + r.height <= v[1] - 7.5
      );
    }, 'menu inside viewport');
  const reload = async () => {
    await read('window.__oldToolbarPage=true');
    await send('Page.reload');
    await until(() => read('!window.__oldToolbarPage'), 'new page');
    await until(ready, 'reloaded canvas');
  };
  await choose(530, 245);
  assert.equal(await rect(plus), null, 'empty more-tools menu has no plus');
  const hide = async (id) => {
    const p = await center(slot(id) + ' > button');
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: p.x,
      y: p.y,
      button: 'right',
      buttons: 2,
      clickCount: 1,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: p.x,
      y: p.y,
      button: 'right',
      buttons: 0,
      clickCount: 1,
    });
    await click('.selection-tool-context-menu [role="menuitem"]');
    await until(() => rect(plus), 'Hide restores plus');
  };
  assert.equal(
    await read(
      `(()=>{const svg=document.querySelector('.object-lock-glyph');return Array.from(svg.children).every(e=>{const b=e.getBBox();return b.x>=1&&b.y>=1&&b.x+b.width<=23&&b.y+b.height<=23})})()`,
    ),
    true,
    'lock paths fit inside the icon',
  );
  await screenshot('lock-unclipped-empty-menu.png');
  await read(`document.querySelector('${slot('lock')} > button').focus()`);
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    modifiers: 1,
    windowsVirtualKeyCode: 13,
  });
  await until(
    () =>
      read(`document.activeElement?.closest('[data-tool-zone]')?.dataset.toolZone==='inventory'`),
    'keyboard focus follows hidden lock',
  );
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    modifiers: 1,
    windowsVirtualKeyCode: 13,
  });
  await frame();
  assert.equal(
    await read(`document.querySelector('.object-lock')?.dataset.locked`),
    'false',
    'releasing Alt+Enter does not activate lock',
  );
  await drag('lock', 'bar', 'colors');
  await hide('lock');
  await click(plus);
  assert.deepEqual(await zoneIds('inventory'), ['lock']);
  await drag('lock', 'bar', 'colors');
  assert.equal(await rect(plus), null, 'restoring last hidden tool removes plus');
  assert.equal(await rect('.selection-tool-menu'), null, 'empty menu closes after drag');
  assert.ok(
    !(await state()).objects.find((o) => o.id === 'text').locked,
    'drag does not lock selection',
  );
  await drag('lock', 'inventory');
  assert.ok(await rect(plus), 'dragging lock into inventory restores plus');
  await reload();
  await choose(530, 245);
  await click(plus);
  assert.deepEqual(await zoneIds('inventory'), ['lock'], 'hidden lock survives reload');
  await click(slot('lock') + ' > button');
  await until(
    () => read(`document.querySelector('.object-lock')?.dataset.locked==='true'`),
    'hidden lock activates',
  );
  assert.ok(await rect('.object-lock'), 'locked selection always exposes unlock');
  const hold = await center('.object-lock');
  await mouse('mousePressed', hold.x, hold.y, 1);
  await until(
    () => read(`document.querySelector('.object-lock')?.dataset.locked!=='true'`),
    'unlock from hidden lock',
    7000,
  );
  await mouse('mouseReleased', hold.x, hold.y);
  assert.ok(await rect(plus), 'unlock restores saved hidden layout');
  await click(plus);
  await drag('lock', 'bar', 'colors');
  await hide('bold');
  await click(plus);
  assert.deepEqual(await zoneIds('inventory'), ['bold']);
  await drag('bold', 'bar', 'strikethrough');
  assert.equal(await rect(plus), null);
  await read(`localStorage.removeItem('terra-board.selection-toolbar-layout')`);
  await read(
    `localStorage.setItem('terra-board.selection-toolbar-hidden',JSON.stringify(['bold','colors']))`,
  );
  await reload();
  await choose(530, 245);
  assert.ok(!(await zoneIds('bar')).includes('bold'), 'migrates earlier hidden choices');
  await click(plus);
  assert.deepEqual(await zoneIds('inventory'), ['bold', 'colors']);
  assert.deepEqual(
    await read(
      `Array.from(document.querySelectorAll('.selection-tool-menu .tool-inventory-name'),el=>el.textContent)`,
    ),
    ['Bold', 'Colors'],
  );
  assert.equal(
    await read(
      `Array.from(document.querySelectorAll('.selection-tool-menu [data-tool-id]')).every(el=>!!el.querySelector('svg'))`,
    ),
    true,
    'every inventory tool has its own icon',
  );
  await read(
    `window.__nativeDrags=0;document.addEventListener('dragstart',()=>window.__nativeDrags++);window.__toolbarAnimations=0;const original=Element.prototype.animate;Element.prototype.animate=function(...args){if(this.closest('.selection-toolbar-content')||this.classList.contains('toolbar-held-icon'))window.__toolbarAnimations++;return original.apply(this,args);}`,
  );
  await drag('bold', 'bar', 'strikethrough');
  assert.equal(
    (await state()).objects.find((o) => o.id === 'text').bold,
    undefined,
    'drag does not activate Bold',
  );
  assert.ok(
    (await zoneIds('bar')).indexOf('bold') < (await zoneIds('bar')).indexOf('strikethrough'),
  );
  await drag('bold', 'bar', 'delete');
  assert.equal((await zoneIds('bar')).at(-1), 'bold', 'reorder to end');
  await drag('bold', 'bar', 'strikethrough');
  assert.ok(
    (await zoneIds('bar')).indexOf('bold') < (await zoneIds('bar')).indexOf('strikethrough'),
    'reorder before strikethrough',
  );
  await drag('center-y', 'inventory', 'colors');
  await drag('delete', 'inventory', (await zoneIds('inventory'))[0]);
  assert.equal((await state()).objects.length, 4, 'drag does not delete the object');
  await drag('colors', 'bar', 'bold');
  assert.ok(await rect('.selection-toolbar-slots .color-options'), 'palette restored');
  await drag('center-x', 'inventory', 'delete');
  await drag('delete', 'inventory', (await zoneIds('inventory'))[0]);
  assert.equal((await zoneIds('inventory'))[0], 'delete', 'inventory can reorder');
  assert.equal(await read('window.__nativeDrags'), 0, 'no native drag ghost');
  assert.ok(
    (await read('window.__toolbarAnimations')) > 6,
    'sibling, glass and drop animations played',
  );
  await screenshot('object-tools-drag-layout.png');

  // Invalid drops and Escape must roll back live previews without saving them.
  const saved = await stored();
  let from = await begin('bold'),
    to = await destination('inventory', 'delete');
  await moveTo(from, to);
  await moveTo(to, { x: 1280, y: 110 });
  await release({ x: 1280, y: 110 });
  assert.deepEqual(await stored(), saved);
  assert.ok((await zoneIds('bar')).includes('bold'));
  from = await begin('bold');
  to = await destination('inventory', 'delete');
  await moveTo(from, to);
  await key('Escape');
  await release(to);
  assert.deepEqual(await stored(), saved);
  assert.ok(await rect(plus), 'Escape during drag preserves the object selection');

  await reload();
  await choose(530, 245);
  await click(plus);
  assert.deepEqual(await stored(), saved, 'both orders survive reload');
  assert.deepEqual(
    await zoneIds('inventory'),
    saved.inventory.filter((id) =>
      [
        'lock',
        'colors',
        'bold',
        'strikethrough',
        'center-x',
        'center-y',
        'duplicate',
        'delete',
      ].includes(id),
    ),
  );
  await key('Escape');
  await choose(530, 510);
  assert.deepEqual(
    await zoneIds('bar'),
    saved.bar.filter((id) =>
      [
        'lock',
        'colors',
        'bold',
        'strikethrough',
        'center-x',
        'center-y',
        'duplicate',
        'delete',
      ].includes(id),
    ),
    'shared controls keep their order on notes',
  );
  await choose(530, 245);
  await click(slot('bold') + ' > button');
  await until(
    async () => (await state()).objects.find((o) => o.id === 'text').bold,
    'restored button works',
  );

  // Moving controls must leave an active text editor and its draft intact.
  await at(530, 245);
  await at(530, 245, 2);
  await until(() => rect('.text-editor'), 'text editor');
  await drag('bold', 'inventory', 'delete');
  assert.ok(await rect('.text-editor'));
  await drag('bold', 'bar', 'strikethrough');
  assert.ok(await rect('.text-editor'));
  await key('Escape');
  assert.ok(await rect('.text-editor'), 'Escape closes the menu first');
  await key('Escape');

  // Keyboard alternatives preserve the same layout and can empty the ribbon.
  let ids = await zoneIds('bar');
  for (const id of ids) {
    await read(`document.querySelector('${slot(id)} > button').focus()`);
    await key('Enter', 'Enter', 1);
    await until(async () => !(await zoneIds('bar')).includes(id), 'keyboard moved ' + id);
    await until(
      () =>
        read(
          `document.activeElement?.closest('[data-tool-id]')?.dataset.toolId===${JSON.stringify(id)} && document.activeElement?.closest('[data-tool-zone]')?.dataset.toolZone==='inventory'`,
        ),
      'keyboard focus settled on ' + id,
    );
  }
  assert.deepEqual(await zoneIds('bar'), []);
  assert.ok(await rect(plus), 'plus stays reachable with every customizable tool hidden');
  await drag('bold', 'bar');
  await key('Escape');
  await read(`document.querySelector('${plus}').focus()`);
  await key(' ', 'Space');
  await until(() => rect('.selection-tool-menu'), 'Space opens menu');
  await key('Escape');

  await choose(975, 482);
  await drag('arrow-style', 'inventory');
  assert.equal(await rect('.arrow-controls'), null);
  await drag('arrow-style', 'bar');
  assert.ok(await rect('.arrow-controls'));
  await key('Escape');
  await choose(905, 605);
  await drag('below', 'inventory');
  assert.ok((await zoneIds('inventory')).includes('below'), 'gallery tools can be moved');
  await key('Escape');
  await choose(530, 245);
  await send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: 'dark' },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 740,
    height: 520,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click(plus);
  await menuFits();
  assert.equal(
    await read(
      `(()=>{const e=document.querySelector('.selection-tool-menu'),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.bottom-24))})()`,
    ),
    true,
    'menu remains above lower ribbon',
  );
  await screenshot('object-tools-narrow-dark.png');
  await drag('bold', 'inventory', 'colors');
  await menuFits();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: 'SELECTION_TOOLBAR_DRAG_OK',
      root,
      checks: [
        'unclipped lock icon',
        'empty inventory hides plus',
        'right-click Hide restores plus',
        'lock drag and persistence',
        'hidden lock activation and unlock',
        'legacy migration',
        'icons and names',
        'both directions',
        'reorder bar and inventory',
        'animations',
        'no activation or native drag',
        'outside and Escape rollback',
        'reload and context persistence',
        'compound controls',
        'editing',
        'keyboard',
        'empty bar',
        'gallery',
        'dark narrow reduced motion',
      ],
    }),
  );
} catch (error) {
  console.error(error);
  if (socket) {
    try {
      await screenshot('failure.png');
      console.error(await read('document.body.innerText'));
      console.error(
        await read(
          `(()=>{const e=document.querySelector('.selection-tool-menu'),r=e?.getBoundingClientRect();return {rect:r?.toJSON(),style:e?.getAttribute('style'),viewport:[innerWidth,innerHeight],root:document.querySelector('.selection-toolbar-content')?.getBoundingClientRect().toJSON()}})()`,
        ),
      );
    } catch {}
  }
  console.error('Library:', root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
