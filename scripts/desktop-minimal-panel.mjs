// Minimal panel interaction and layout checks against an isolated desktop library.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
mkdirSync(resolve('.local-test'), { recursive: true });
const root = mkdtempSync(resolve('.local-test/minimal-panel-'));
const store = new Store(root);
const board = store.createBoard({ name: 'Design notes' });
const folder = store.createFolder({ name: 'Projects' });
store.createBoard({ name: 'Inside folder', folderId: folder.id });
store.setLastBoard({ id: board.id });
store.close();
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const env = { ...process.env, CANVAS_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const executable = process.env.CANVAS_EXECUTABLE || require('electron');
const child = spawn(
  executable,
  [...(process.env.CANVAS_EXECUTABLE ? [] : ['.']), `--remote-debugging-port=${port}`],
  {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let diagnostics = '';
child.stderr.on('data', (b) => (diagnostics += b));
child.stdout.on('data', () => {});
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

  const menuLabels = () =>
    read(`[...document.querySelectorAll('[role="menuitem"]')].map(e => e.textContent.trim())`);
  const choose = async (label) => {
    const point = await read(`(() => {
      const e = [...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent.trim() === ${JSON.stringify(label)});
      if (!e) return null;
      const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    assert.ok(point, `menu offers ${label}`);
    await click(point.x, point.y);
  };
  const panelMenu = async () => {
    const r = await rect('.launcher');
    const horizontal = r.width > r.height;
    await click(r.x + (horizontal ? 3 : 32), r.y + (horizontal ? 32 : 3), 'right');
  };
  const ready = () =>
    until(
      () =>
        read(`!!document.querySelector('canvas') && !document.querySelector('.canvas-loading')`),
      'canvas ready',
    );
  const reload = async () => {
    await read('window.minimalReloadPending = true');
    await send('Page.reload');
    await until(() => read('!window.minimalReloadPending'), 'new document');
    await ready();
  };
  assert.equal(
    await rect('[aria-label="Library options"]'),
    null,
    'full panel has no duplicate menu button',
  );
  assert.equal(await rect('.launcher [aria-label="Search boards"]'), null, 'no panel search icon');
  const searchShortcut = async () => {
    await key('f', 'KeyF', 2);
    await until(
      () =>
        read(
          `document.activeElement?.matches('.modal input[aria-label="Search boards and content"]')`,
        ),
      'Ctrl+F opens and focuses board search',
    );
    await send('Input.insertText', { text: 'Inside folder' });
    await until(
      () =>
        read(`document.querySelector('.search-results')?.textContent.includes('Inside folder')`),
      'search finds a board in a folder',
    );
    await key('Escape', 'Escape');
    await until(() => read(`!document.querySelector('.modal')`), 'search closes');
  };
  await searchShortcut();
  await panelMenu();
  await choose('Minimal mode');
  await until(
    () => read(`document.querySelector('.launcher').dataset.minimal === 'true'`),
    'minimal mode',
  );
  await read(`localStorage.setItem('terra-board.launcher-centered', 'true')`);
  await reload();

  for (const edge of ['bottom', 'left', 'top', 'right']) {
    await read(`localStorage.setItem('terra-board.launcher-edge', ${JSON.stringify(edge)})`);
    await reload();
    const horizontal = edge === 'top' || edge === 'bottom';
    const viewport = await read('({width: innerWidth, height: innerHeight})');
    const rail = await rect('.launcher');
    if (edge === 'right' || edge === 'top') {
      const fullscreen = await rect('.fullscreen-toggle');
      assert.equal(fullscreen.y, 13, 'fullscreen icon stays at clear top edge');
      assert.equal(
        viewport.width - fullscreen.x - fullscreen.width,
        16,
        'fullscreen icon stays at clear right edge',
      );
    }
    if (edge === 'left') {
      await until(
        async () => (await rect('.board-header')).x === 0,
        'title stays left above compact panel',
      );
    }
    const boardSlot = await rect(`[data-item="${board.id}"]`);
    const center = { x: boardSlot.x + boardSlot.width / 2, y: boardSlot.y + boardSlot.height / 2 };
    assert.equal(
      await read(
        `document.elementFromPoint(${center.x + 22}, ${center.y})?.closest('[data-item]')?.dataset.item`,
      ),
      board.id,
      'small surround remains a board target',
    );
    const glass = horizontal
      ? { x: center.x, y: center.y - 27 }
      : { x: center.x - 27, y: center.y };
    assert.equal(
      await read(`!!document.elementFromPoint(${glass.x}, ${glass.y})?.closest('[data-item]')`),
      false,
      'glass outside the icon surround is not a board target',
    );
    await mouse('mousePressed', glass.x, glass.y);
    await mouse('mouseMoved', glass.x + 12, glass.y + 12);
    await until(
      () => read(`!!document.querySelector('.launcher.is-dragging')`),
      'freed glass starts panel drag',
    );
    assert.equal(
      await read(`!!document.querySelector('[data-reorder-avatar]')`),
      false,
      'glass does not reorder the board',
    );
    await key('Escape', 'Escape');
    await mouse('mouseReleased', glass.x + 12, glass.y + 12);
    await sleep(420);
    if (edge === 'bottom' || edge === 'right') {
      await until(async () => {
        const zoom = await rect('.canvas-zoom');
        return (
          Math.abs(viewport.width - zoom.x - zoom.width - 14) < 1 &&
          Math.abs(viewport.height - zoom.y - zoom.height - 25) < 1
        );
      }, `zoom stays in clear ${edge} corner`);
      await send('Emulation.setDeviceMetricsOverride', {
        width: edge === 'bottom' ? 500 : viewport.width,
        height: edge === 'right' ? 240 : viewport.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await until(
        () => read(`document.querySelector('.canvas-zoom').dataset.cornerClear === 'false'`),
        'zoom detects obstruction',
      );
      await sleep(800);
      const displaced = await rect('.canvas-zoom');
      const obstacle = await rect('.launcher');
      assert.ok(
        displaced.x + displaced.width <= obstacle.x || displaced.y + displaced.height <= obstacle.y,
        'zoom moves clear of obstructing panel',
      );
      await send('Emulation.clearDeviceMetricsOverride');
      await until(async () => {
        const zoom = await rect('.canvas-zoom');
        return (
          Math.abs(viewport.width - zoom.x - zoom.width - 14) < 1 &&
          Math.abs(viewport.height - zoom.y - zoom.height - 25) < 1
        );
      }, 'zoom returns to clear corner after resize');
    }
    if (edge === 'top') {
      await until(async () => (await rect('.board-header')).y === 0, 'title settles beside panel');
      const header = await rect('.board-header');
      const save = await rect('.save-indicator');
      assert.ok(save.x + save.width + 12 < rail.x, 'title has room beside compact panel');
      assert.equal(header.y, 0, 'top compact panel leaves title in the available top row');
    }
    assert.equal(await read(`document.querySelector('.app-shell').dataset.dock`), edge);
    assert.equal(
      await read(`document.querySelector('.launcher').dataset.minimal`),
      'true',
      'mode persists',
    );
    assert.equal(await rect('[aria-label="Search boards"]'), null, 'no search button');
    await searchShortcut();
    assert.equal(await rect('[aria-label="Library options"]'), null, 'no options button');
    const item = await rect('.launcher-scroll > .launch-item');
    const create = await rect('[aria-label="Create"]');
    const span = horizontal ? create.x + create.width - item.x : create.y + create.height - item.y;
    const length = horizontal ? rail.width : rail.height;
    assert.ok(length - span < 60, `glass tightly wraps icons at ${edge}`);
    assert.ok(length < (horizontal ? viewport.width : viewport.height) / 2, 'panel is compact');
    assert.ok(
      Math.abs(
        horizontal
          ? rail.x + rail.width / 2 - viewport.width / 2
          : rail.y + rail.height / 2 - viewport.height / 2,
      ) < 1,
      'panel is centered',
    );
    const edgeGap =
      edge === 'bottom'
        ? viewport.height - rail.y - rail.height
        : edge === 'right'
          ? viewport.width - rail.x - rail.width
          : edge === 'top'
            ? rail.y
            : rail.x;
    assert.ok(Math.abs(edgeGap) < 1, `minimal panel is flush with the ${edge} app edge`);
    const corners = {
      bottom: [14, 14, 0, 0],
      left: [0, 14, 14, 0],
      top: [0, 0, 14, 14],
      right: [14, 0, 0, 14],
    };
    assert.deepEqual(
      await read(
        `(() => { const s = getComputedStyle(document.querySelector('.launcher')); return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map(parseFloat) })()`,
      ),
      corners[edge],
      'only exposed corners are gently rounded',
    );
    const outside = horizontal
      ? { x: 20, y: rail.y + rail.height / 2 }
      : { x: rail.x + rail.width / 2, y: 20 };
    assert.equal(
      await read(`!!document.elementFromPoint(${outside.x}, ${outside.y})?.closest('.launcher')`),
      false,
      'unused edge belongs to canvas',
    );

    await panelMenu();
    const labels = await menuLabels();
    for (const label of [
      'Search',
      'New board',
      'New folder',
      'Import board…',
      'Trash',
      'Settings',
      'Keyboard shortcuts',
      'Full panel',
      'Uncenter panel',
      'Hide panel',
    ])
      assert.ok(labels.includes(label), `panel context menu offers ${label}`);
    await choose('Search');
    await until(() => read(`!!document.querySelector('.library-search')`), 'search opens');
    assert.ok(await rect('.modal'), 'search opens through panel');
    await key('Escape', 'Escape');

    await clickSelector('[aria-label="Open folder Projects"]');
    const sheet = await rect('.folder-sheet');
    assert.ok(
      sheet &&
        sheet.x >= 0 &&
        sheet.y >= 0 &&
        sheet.x + sheet.width <= viewport.width &&
        sheet.y + sheet.height <= viewport.height,
      'folder sheet stays in view',
    );
    await clickSelector('[aria-label="Close folder"]');
    await clickSelector('[aria-label="Create"]');
    assert.ok((await menuLabels()).includes('New board'), 'create menu works');
    await key('Escape', 'Escape');
    const icon = await rect(`[data-item="${board.id}"]`);
    await click(icon.x + icon.width / 2, icon.y + icon.height / 2, 'right');
    assert.ok((await menuLabels()).includes('Rename'), 'board menu is preserved');
    await key('Escape', 'Escape');

    await read(`window.minimalCanvas = document.querySelector('canvas')`);
    await panelMenu();
    await choose('Hide panel');
    await until(
      () => read(`getComputedStyle(document.querySelector('.launcher')).visibility === 'hidden'`),
      'hidden panel',
    );
    await searchShortcut();
    await clickSelector('[aria-label="Show board panel"]');
    await until(
      () =>
        read(
          `!document.querySelector('.launcher').hasAttribute('inert') && getComputedStyle(document.querySelector('.launcher')).opacity === '1'`,
        ),
      'restored panel',
    );
    assert.equal(
      await read(
        `document.querySelector('.launcher').dataset.minimal === 'true' && window.minimalCanvas === document.querySelector('canvas')`,
      ),
      true,
      'restore retains mode and canvas',
    );
    await panelMenu();
    await choose('Uncenter panel');
    await sleep(380);
    const leading = await rect('.launcher');
    if (edge === 'right') {
      const fullscreen = await rect('.fullscreen-toggle');
      assert.equal(
        viewport.width - fullscreen.x - fullscreen.width,
        86,
        'fullscreen icon shifts left when panel overlaps',
      );
    }
    if (edge === 'left') {
      assert.equal(
        (await rect('.board-header')).x,
        72,
        'title shifts right when left panel overlaps',
      );
    }
    if (edge === 'top') {
      assert.equal((await rect('.board-header')).y, 72, 'overlapping panel moves title below');
    }
    assert.ok(
      (horizontal ? leading.x : leading.y) < 12,
      'uncenter aligns compact panel to leading edge',
    );
    await panelMenu();
    await choose('Center panel');
    await sleep(380);
    if (edge === 'right') {
      const fullscreen = await rect('.fullscreen-toggle');
      assert.equal(
        viewport.width - fullscreen.x - fullscreen.width,
        16,
        'fullscreen icon returns to clear right corner',
      );
      await key('F11', 'F11');
      await until(
        () => read(`!document.querySelector('.fullscreen-toggle')`),
        'fullscreen icon hides',
      );
      await key('Escape', 'Escape');
      await until(
        () =>
          read(`document.querySelector('.fullscreen-toggle')?.dataset.fitsBesidePanel === 'true'`),
        'fullscreen icon restores in clear corner',
      );
      await until(
        () => read(`innerWidth === ${viewport.width} && innerHeight === ${viewport.height}`),
        'window bounds restored after fullscreen',
      );
    }
    if (edge === 'left') {
      assert.equal((await rect('.board-header')).x, 0, 'title returns left when panel moves below');
    }
    if (edge === 'top') {
      assert.equal((await rect('.board-header')).y, 0, 'centering frees title space again');
      // Editing the actual title must recheck its growing/shrinking footprint.
      await clickSelector('.board-identity');
      await clickSelector('.board-identity');
      await key('F2', 'F2');
      await until(
        () => read(`document.querySelector('.board-title').isContentEditable`),
        'title editing',
      );
      await key('a', 'KeyA', 2);
      await send('Input.insertText', {
        text: 'A very long board title that needs more space beside the centered panel',
      });
      await sleep(380);
      assert.equal((await rect('.board-header')).y, 72, 'long title moves below overlapping glass');
      await key('Escape', 'Escape');
      await sleep(380);
      assert.equal((await rect('.board-header')).y, 0, 'short title returns to top');
    }

    await send('Emulation.setDeviceMetricsOverride', {
      width: 190,
      height: 190,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(380);
    if (edge === 'right') {
      const fullscreen = await rect('.fullscreen-toggle');
      assert.equal(
        190 - fullscreen.x - fullscreen.width,
        86,
        'short right panel moves fullscreen icon clear',
      );
    }
    if (edge === 'left') {
      assert.equal((await rect('.board-header')).x, 72, 'short window requires title inset');
    }
    if (edge === 'top') {
      assert.equal((await rect('.board-header')).y, 72, 'small window moves title below panel');
    }
    assert.ok(
      await read(
        `(() => { const e = document.querySelector('.launcher-scroll'); return ${horizontal} ? e.scrollWidth > e.clientWidth : e.scrollHeight > e.clientHeight })()`,
      ),
      'small panel scrolls',
    );
    await read(
      `(() => {const e = document.querySelector('.launcher-scroll');e.scrollTop = e.scrollHeight;e.scrollLeft = e.scrollWidth})()`,
    );
    const end = await rect('[aria-label="Create"]');
    assert.ok(
      end.x >= 0 && end.y >= 0 && end.x + end.width <= 190 && end.y + end.height <= 190,
      'last control reachable in small window',
    );
    await send('Emulation.clearDeviceMetricsOverride');
    await read(
      `(() => {const e = document.querySelector('.launcher-scroll');e.scrollTop = 0;e.scrollLeft = 0})()`,
    );
    await sleep(380);
    if (edge === 'right') {
      const fullscreen = await rect('.fullscreen-toggle');
      assert.equal(
        viewport.width - fullscreen.x - fullscreen.width,
        16,
        'tall window restores fullscreen corner',
      );
    }
    if (edge === 'left') {
      assert.equal(
        (await rect('.board-header')).x,
        0,
        'taller window restores left title position',
      );
    }
    if (edge === 'top') {
      assert.equal((await rect('.board-header')).y, 0, 'enlarging window restores top row');
    }
    const shot = await send('Page.captureScreenshot');
    writeFileSync(join(root, `minimal-${edge}.png`), Buffer.from(shot.data, 'base64'));
    if (edge === 'bottom') {
      const detail = await send('Page.captureScreenshot', {
        clip: {
          x: rail.x - 16,
          y: rail.y - 16,
          width: rail.width + 32,
          height: rail.height + 16,
          scale: 2,
        },
      });
      writeFileSync(join(root, 'minimal-bottom-detail.png'), Buffer.from(detail.data, 'base64'));
    }
  }

  // Move the compact glass itself with a real pointer gesture.
  const from = await rect('.launcher');
  const size = await read('({width: innerWidth, height: innerHeight})');
  const start = { x: from.x + 32, y: from.y + 3 };
  const targetPoint = { x: size.width / 2, y: 22 };
  await mouse('mousePressed', start.x, start.y);
  for (let i = 1; i <= 12; i++) {
    await mouse(
      'mouseMoved',
      start.x + ((targetPoint.x - start.x) * i) / 12,
      start.y + ((targetPoint.y - start.y) * i) / 12,
    );
    await sleep(12);
  }
  assert.equal(
    await read(`document.querySelector('.dock-preview')?.dataset.edge`),
    'top',
    'minimal dock previews target',
  );
  await mouse('mouseReleased', targetPoint.x, targetPoint.y);
  await sleep(420);
  assert.equal(
    await read(`document.querySelector('.app-shell').dataset.dock`),
    'top',
    'minimal panel docks',
  );
  const docked = await rect('.launcher');
  assert.ok(
    docked.width < size.width / 2 && docked.height === 72,
    'panel stays compact after docking',
  );
  assert.equal((await rect('.board-header')).y, 0, 'pointer docking keeps title beside panel');

  await panelMenu();
  await choose('Settings');
  assert.ok(await rect('.settings-page'), 'settings remain accessible');
  await key('Escape', 'Escape');
  await panelMenu();
  await choose('Full panel');
  assert.equal(
    await rect('.launcher [aria-label="Search boards"]'),
    null,
    'full panel has no search icon',
  );
  assert.equal(
    await rect('[aria-label="Library options"]'),
    null,
    'full panel keeps context actions on right-click',
  );
  const full = await rect('.launcher');
  assert.equal(full.width, size.width, 'full panel spans edge again');
  await until(async () => (await rect('.board-header')).y === 72, 'full panel title settles');
  assert.equal((await rect('.board-header')).y, 72, 'full top panel still reserves its row');
  await reload();
  assert.equal(
    await read(`document.querySelector('.launcher').dataset.minimal`),
    undefined,
    'full mode persists',
  );
  assert.deepEqual(errors, [], 'no runtime exceptions');
  console.log(
    JSON.stringify({
      passed: true,
      checks:
        'Minimal bounds, round glass, controls, full context menu, alignment, folders, board menus, hide/restore, scrolling, four edges, pointer docking, settings, persistence, return to full mode',
      artifacts: root,
    }),
  );
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    const shot = await send('Page.captureScreenshot');
    writeFileSync(join(root, 'failure.png'), Buffer.from(shot.data, 'base64'));
  }
  console.error(error, diagnostics, root);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
