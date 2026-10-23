// End-to-end check of a built Terra Board, used by the Linux workflow on the
// AppImage. It starts the app with the library it would use for a real user
// (point XDG_DATA_HOME or CANVAS_DATA_DIR at a throwaway folder first), adds a
// board with a note and an image through the app's own bridge, closes the
// window the way the user does, starts the app again and checks that the board,
// note and image came back and the window shows the board.
//
//   node scripts/app-smoke.mjs <executable> [extra args...]
//
// TERRA_SMOKE_LIBRARY: the library folder the app must use (checked).
// TERRA_SMOKE_SCREENSHOT: where to save a PNG of the reopened board.
// TERRA_SMOKE_EXTENSIONS: a folder of built extensions (release/extensions);
//   the second start installs Background removal and Song links from it,
//   cuts out the image and runs yt-dlp.
// TERRA_SMOKE_OCR=1: text recognition must be offered and read text the page
//   draws (Tesseract on Linux, run without the AppImage's libraries).
// TERRA_SMOKE_DESKTOP_ENTRY: a menu entry the app must have written that starts
//   <executable> (an AppImage integrates itself).
//
// The second start also switches on AI access and connects the way Claude
// Desktop does, with the stdio command Settings shows.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [executable, ...extraArgs] = process.argv.slice(2);
if (!executable) throw Error('Usage: node scripts/app-smoke.mjs <executable> [args...]');
const expectedLibrary = process.env.TERRA_SMOKE_LIBRARY;
const screenshot = process.env.TERRA_SMOKE_SCREENSHOT;
const extensionSource = process.env.TERRA_SMOKE_EXTENSIONS;
const extensionsDir = extensionSource && mkdtempSync(join(tmpdir(), 'terra-smoke-extensions-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (text) => console.log(`[smoke] ${text}`);

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

// One run of the app: start it, attach to its window over the DevTools
// protocol, run `body`, then close the window and wait for a clean exit.
async function run(label, body) {
  const port = await freePort();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CANVAS_DEV_URL;
  if (extensionSource) {
    env.TERRA_EXTENSIONS_SOURCE = extensionSource;
    env.TERRA_EXTENSIONS_DIR = extensionsDir;
  }
  step(`${label}: starting`);
  const child = spawn(executable, [...extraArgs, `--remote-debugging-port=${port}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  let socket;
  try {
    let page;
    for (let i = 0; i < 120 && !page; i++) {
      await wait(500);
      if (child.exitCode !== null) break;
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        page = targets.find((t) => t.type === 'page' && t.url.startsWith('canvas-app://app/'));
      } catch {}
    }
    if (!page) throw Error('The window did not open');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(Error('DevTools connection failed'));
    });
    let id = 0;
    const pending = new Map();
    const errors = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown')
        errors.push(message.params.exceptionDetails.exception?.description || 'exception');
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      message.error ? waiter.reject(Error(message.error.message)) : waiter.resolve(message.result);
    };
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    await send('Runtime.enable');
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw Error(result.exceptionDetails.exception?.description || 'Evaluation failed');
      return result.result.value;
    };
    // The board has drawn once the canvas is in the page and the bridge answers.
    for (let i = 0; ; i++) {
      const ready = await evaluate(
        "!!window.canvas && document.readyState === 'complete' && !!document.querySelector('canvas')",
      ).catch(() => false);
      if (ready) break;
      if (i > 120) throw Error('The board did not load');
      await wait(250);
    }
    await body({ evaluate, send });
    if (errors.length) console.warn(`[smoke] ${label}: page errors:\n${errors.join('\n')}`);
    step(`${label}: closing the window`);
    // window.close() takes the same path as the title bar's X: the board saves,
    // then the app quits.
    await evaluate('setTimeout(() => window.close(), 50), true');
    const result = await Promise.race([exited, wait(30000).then(() => null)]);
    if (!result) throw Error('The app did not exit after its window closed');
    assert.equal(result.code, 0, `exit code ${result.code} (${result.signal ?? 'no signal'})`);
    step(`${label}: exited cleanly`);
  } catch (e) {
    console.error(output);
    child.kill('SIGKILL');
    throw e;
  } finally {
    socket?.close();
  }
}

const boardName = 'Linux smoke board';
const noteText = 'Saved on Linux';
await run('first start', async ({ evaluate }) => {
  const library = await evaluate('window.canvas.dataDirectory()');
  step(`library: ${JSON.stringify(library)}`);
  const folder = typeof library === 'string' ? library : library?.path || library?.directory;
  if (expectedLibrary) assert.equal(folder, expectedLibrary);
  if (folder) assert.ok(existsSync(join(folder, 'library.sqlite')), 'library.sqlite missing');
  const desktopEntry = process.env.TERRA_SMOKE_DESKTOP_ENTRY;
  if (desktopEntry) {
    const entry = readFileSync(desktopEntry, 'utf8');
    assert.ok(entry.includes(`Exec="${executable}" %U`), entry);
    assert.match(entry, /x-scheme-handler\/terraboard/);
    step(`desktop entry: ${desktopEntry}`);
  }
  const platform = await evaluate('window.canvas.platform');
  step(`platform: ${platform}`);
  // A 64x48 PNG drawn in the page, imported like a pasted image, then a board
  // holding it and a note.
  const saved = await evaluate(`(async () => {
    const c = new OffscreenCanvas(64, 48), g = c.getContext('2d');
    g.fillStyle = '#e33b36'; g.fillRect(0, 0, 32, 48);
    g.fillStyle = '#366cdc'; g.fillRect(32, 0, 32, 48);
    const bytes = await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer();
    const asset = await window.canvas.invoke('importAsset', { name: 'smoke.png', bytes });
    const board = await window.canvas.invoke('createBoard', { name: ${JSON.stringify(boardName)} });
    await window.canvas.invoke('patchBoard', {
      id: board.id, revision: 0, operationId: 'smoke-' + Date.now(), deleted: [],
      upserts: [
        { id: 'smoke-note', type: 'note', x: 240, y: 200, width: 220, height: 160, z: 1,
          text: ${JSON.stringify(noteText)} },
        { id: 'smoke-image', type: 'image', assetId: asset.id, x: 500, y: 208, width: 192, height: 144, z: 2 },
      ],
    });
    await window.canvas.invoke('setLastBoard', { id: board.id });
    return { board: board.id, asset: asset.id };
  })()`);
  step(`saved board ${saved.board} with image ${saved.asset}`);
});

await run('second start', async ({ evaluate, send }) => {
  const result = await evaluate(`(async () => {
    const library = await window.canvas.invoke('library');
    const board = library.boards.find((b) => b.name === ${JSON.stringify(boardName)});
    if (!board) return { boards: library.boards.map((b) => b.name) };
    const { objects } = await window.canvas.invoke('loadBoard', { id: board.id });
    const image = objects.find((o) => o.id === 'smoke-image');
    const size = image && await window.canvas.assetDimensions(image.assetId);
    return {
      objects: objects.map((o) => o.type + ':' + (o.text || o.id)),
      size,
      assetId: image?.assetId,
    };
  })()`);
  step(`reopened: ${JSON.stringify(result)}`);
  assert.ok(result.objects, `board missing; library has ${JSON.stringify(result.boards)}`);
  assert.ok(result.objects.includes('note:' + noteText), 'note missing');
  assert.ok(result.objects.includes('image:smoke-image'), 'image missing');
  assert.equal(result.size?.width, 64, 'image size');
  if (process.env.TERRA_SMOKE_OCR === '1') {
    const read = await evaluate(`(async () => {
      if (!window.canvas.recognizeImage) return { offered: false };
      const c = new OffscreenCanvas(900, 160), g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, 900, 160);
      g.fillStyle = '#111'; g.font = '56px sans-serif'; g.fillText('Terra Board reads text', 30, 100);
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
      const text = await window.canvas.recognizeImage(bytes);
      return { offered: true, lines: text.lines.map((l) => l.words.map((w) => w.text).join(' ')) };
    })()`);
    step(`text recognition: ${JSON.stringify(read)}`);
    assert.ok(read.offered, 'text recognition is not offered');
    assert.match(read.lines.join(' '), /Terra Board reads text/);
  }
  if (extensionSource) {
    for (const id of ['background-removal', 'song-links']) {
      await evaluate(`window.canvas.extensions.install(${JSON.stringify(id)})`);
      step(`extension installed: ${id}`);
    }
    // onnxruntime and the model run in the app's utility process.
    const cutout = await evaluate(
      `window.canvas.invoke('removeBackground', { id: ${JSON.stringify(result.assetId)} }).then((a) => a.id)`,
    );
    step(`background removal ran: ${cutout === result.assetId ? 'nothing to cut' : cutout}`);
    const ytDlp = join(
      extensionsDir,
      'song-links',
      process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp',
    );
    step(`yt-dlp ${execFileSync(ytDlp, ['--version'], { encoding: 'utf8' }).trim()}`);
  }
  // AI access: the stdio entry from Settings must reach this running app.
  const mcpPort = await freePort();
  const status = await evaluate(
    `window.canvas.mcpUpdate({ enabled: true, port: ${mcpPort} }).then(() => window.canvas.mcpStatus())`,
  );
  assert.ok(status.running, `MCP server not running: ${status.error}`);
  const entry = JSON.parse(status.claudeConfig).mcpServers.terra_board;
  step(`MCP stdio command: ${entry.command} ${entry.args.join(' ').slice(0, 80)}`);
  const env = { ...process.env, ...entry.env };
  const client = new Client({ name: 'terra-smoke', version: '1' });
  const transport = new StdioClientTransport({ ...entry, env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (d) => (stderr += d));
  try {
    await Promise.race([
      client.connect(transport),
      wait(60000).then(() => {
        throw Error('MCP stdio did not start');
      }),
    ]);
    const listed = await client.callTool({ name: 'list_boards', arguments: {} });
    assert.ok(!listed.isError, listed.content?.[0]?.text);
    assert.match(listed.content[0].text, new RegExp(boardName));
    step('MCP stdio: list_boards sees the board');
  } catch (e) {
    console.error(stderr);
    throw e;
  } finally {
    await client.close().catch(() => {});
  }
  await evaluate('window.canvas.mcpUpdate({ enabled: false })');
  // The last board opens on start; give it a moment to draw its image.
  await wait(1500);
  if (screenshot) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(screenshot, Buffer.from(data, 'base64'));
    step(`screenshot: ${screenshot}`);
  }
});
console.log('APP_SMOKE_OK');
