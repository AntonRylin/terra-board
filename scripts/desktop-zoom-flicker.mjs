// Real wheel input + screenshot pixels, using a disposable packaged library.
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
const root = mkdtempSync(resolve('.local-test/zoom-flicker-'));
const store = new Store(root);
const solid = (size, background) =>
  sharp({ create: { width: size, height: size, channels: 4, background } });
const asset = await store.importAsset({
  bytes: await solid(2048, '#e83d31').png().toBuffer(),
  name: 'Resolution fixture.png',
});
// Deliberately distinguish resolutions to verify both continuity AND promotion
// to the newly decoded texture. This changes only this disposable fixture.
writeFileSync(
  store.asset({ id: asset.id, variant: 'thumb' }).file,
  await solid(256, '#287fe5').webp().toBuffer(),
);
const boards = [];
for (const zoom of [1, 1.4]) {
  const board = store.createBoard({ name: `Zoom from ${zoom}` });
  store.patchBoard({
    id: board.id,
    revision: 0,
    camera: { x: 600 * (1 - zoom), y: 400 * (1 - zoom), zoom },
    upserts: [
      {
        id: 'image',
        type: 'image',
        assetId: asset.id,
        x: 480,
        y: 280,
        width: 240,
        height: 240,
        z: 1,
      },
      {
        id: 'light',
        type: 'note',
        color: '#ffcc66',
        x: 830,
        y: 280,
        width: 180,
        height: 180,
        z: 2,
      },
    ],
  });
  boards.push(board);
}
store.setLastBoard({ id: boards[0].id });
store.close();
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const env = { ...process.env, CANVAS_DATA_DIR: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const child = spawn(
  process.env.CANVAS_EXECUTABLE || resolve('release/win-unpacked/Terra Board.exe'),
  [`--remote-debugging-port=${port}`],
  {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let diagnostics = '',
  socket,
  nextId = 0;
child.stderr.on('data', (b) => (diagnostics += b));
child.stdout.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(50);
  }
  throw Error('Timed out: ' + label);
};
const pending = new Map(),
  errors = [],
  results = [];
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
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
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
const sample = async (name) => {
  const shot = await send('Page.captureScreenshot');
  const bytes = Buffer.from(shot.data, 'base64');
  if (name) writeFileSync(join(root, name + '.png'), bytes);
  const { data, info } = await sharp(bytes)
    .extract({ left: 590, top: 390, width: 20, height: 20 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = [0, 0, 0];
  for (let i = 0; i < data.length; i += info.channels)
    for (let c = 0; c < 3; c++) rgb[c] += data[i + c];
  const [r, g, b] = rgb.map((v) => Math.round(v / (info.width * info.height)));
  return {
    r,
    g,
    b,
    color: r > 180 && g < 100 && b < 100 ? 'preview' : b > 170 && r < 100 ? 'thumb' : 'blank',
  };
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
  }, 'packaged renderer');
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
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
    window.__zoomProbe = { id: crypto.randomUUID(), resets: 0, releases: [], held: 0, hold: '' };
    for (const prop of ['width','height']) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop);
      Object.defineProperty(HTMLCanvasElement.prototype, prop, {...descriptor, set(value) {
        if (this.classList.contains('night-lighting')) window.__zoomProbe.resets++;
        descriptor.set.call(this, value);
      }});
    }
    // Textures are fetched and decoded off the main thread. Hold the response
    // of the replacement variant so its decode stays in flight.
    const fetchMedia = window.fetch;
    window.fetch = async function(input, init) {
      const response = await fetchMedia.call(this, input, init);
      const url = String(input && input.url || input);
      if (window.__zoomProbe.hold && url.endsWith('/' + window.__zoomProbe.hold)) {
        window.__zoomProbe.held++;
        await new Promise(resolve => window.__zoomProbe.releases.push(resolve));
      }
      return response;
    };
  `,
  });
  for (const theme of ['light', 'dark']) {
    for (const [index, from, to, deltaY] of [
      [0, 'thumb', 'preview', -100],
      [1, 'preview', 'thumb', 200],
    ]) {
      // Persist a known camera so each reload starts with only one variant cached.
      const zoom = index ? 1.4 : 1;
      await read(`(async()=>{
        const b=await window.canvas.invoke('loadBoard',{id:${JSON.stringify(boards[index].id)}});
        await window.canvas.invoke('patchBoard',{id:b.board.id,revision:b.board.revision,camera:{x:${600 * (1 - zoom)},y:${400 * (1 - zoom)},zoom:${zoom}}});
        await window.canvas.invoke('setLastBoard',{id:b.board.id});
        localStorage.setItem('terra-board.theme',${JSON.stringify(theme)});
        localStorage.setItem('terra-board.night-glow','true');
        localStorage.setItem('terra-board.launcher-edge','bottom');
      })()`);
      const previousDocument = await read('window.__zoomProbe?.id');
      await send('Page.reload');
      await until(async () => {
        try {
          return await read(
            `!!window.__zoomProbe && window.__zoomProbe.id!==${JSON.stringify(previousDocument)} && document.documentElement.dataset.theme===${JSON.stringify(theme)} && !!document.querySelector('.zoom-value') && !document.querySelector('.canvas-loading')`,
          );
        } catch {
          return false;
        }
      }, 'reloaded board');
      await until(async () => (await sample()).color === from, 'initial image');
      await read(`window.__zoomProbe.resets=0;window.__zoomProbe.hold=${JSON.stringify(to)}`);
      for (let i = 0; i < 3; i++)
        await send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: 600,
          y: 400,
          deltaX: 0,
          deltaY,
        });
      await until(() => read('window.__zoomProbe.held>0'), 'replacement decode');
      const frames = [];
      for (let i = 0; i < 6; i++)
        frames.push(await sample(i === 0 ? `${theme}-${from}-pending` : null));
      const resets = await read('window.__zoomProbe.resets');
      await read(
        'window.__zoomProbe.hold="";window.__zoomProbe.releases.splice(0).forEach(resolve=>resolve())',
      );
      await until(async () => (await sample()).color === to, 'replacement rendered');
      await sample(`${theme}-${from}-ready`);
      results.push({ theme, from, to, frames, resets });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
  writeFileSync(join(root, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ artifacts: root, results, errors }));
  assert.deepEqual(errors, []);
  for (const result of results) {
    assert.ok(
      result.frames.every((frame) => frame.color === result.from),
      `${result.theme} ${result.from}: image must stay visible while loading`,
    );
    assert.equal(
      result.resets,
      0,
      `${result.theme}: zoom must retain the lighting backing surface`,
    );
  }
  console.log('ZOOM_FLICKER_DESKTOP_OK');
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) {
    console.error(
      'Failure snapshot',
      root,
      await sample('failure'),
      await read(
        `({zoom:document.querySelector('.zoom-value')?.textContent,surface:document.querySelector('.canvas-surface')?.getBoundingClientRect().toJSON(),text:document.body.innerText.slice(0,700)})`,
      ),
    );
  }
  console.error(error, diagnostics);
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
}
