// Telegram frames and Telegram Web in the desktop app, from source (npm run
// build first), with a scratch library and a stand-in for TDLib
// (scripts/fixtures/fake-tdlib.cjs), so no Telegram account is needed:
// installing the extension from release/extensions, entering an API ID (kept
// encrypted), signing in with a QR code, the chat list, opening a chat, a
// board picture dropped into a chat and sent, Telegram photos and text added
// to the board, a board picture dropped into a browser frame's page, Telegram
// Web instead, and signing out. Screenshots go to the scratch folder.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const sharp = require('sharp');

fs.mkdirSync(resolve('.local-test'), { recursive: true });
const root = fs.mkdtempSync(resolve('.local-test/desktop-telegram-'));
const mediaDir = join(root, 'media');
fs.mkdirSync(mediaDir);
const svg = (w, h, body) =>
  sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`),
  )
    .png()
    .toBuffer();
const avatars = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#eda86c'];
for (const [i, color] of avatars.entries())
  fs.writeFileSync(
    join(mediaDir, `avatar-${i + 1}.png`),
    await svg(
      160,
      160,
      `<rect width="160" height="160" fill="${color}"/><circle cx="80" cy="62" r="30" fill="#fff" opacity=".85"/><rect x="34" y="102" width="92" height="60" rx="40" fill="#fff" opacity=".85"/>`,
    ),
  );
const scene = (w, h, a, b) =>
  svg(
    w,
    h,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.72}" cy="${h * 0.3}" r="${h * 0.14}" fill="#fff6d5"/><path d="M0 ${h * 0.75} L${w * 0.3} ${h * 0.45} L${w * 0.55} ${h * 0.7} L${w * 0.75} ${h * 0.5} L${w} ${h * 0.78} V${h} H0Z" fill="#2c3e50" opacity=".55"/>`,
  );
fs.writeFileSync(join(mediaDir, 'photo-1.png'), await scene(1200, 800, '#6dd5ed', '#2193b0'));
fs.writeFileSync(join(mediaDir, 'photo-2.png'), await scene(900, 1200, '#f7971e', '#ffd200'));
fs.writeFileSync(join(mediaDir, 'photo-3.png'), await scene(1280, 720, '#8e2de2', '#4a00e0'));
fs.writeFileSync(join(mediaDir, 'brief.pdf'), '%PDF-1.4\n% Terra test brief\n');

// A page that reports what is dropped on it, for the browser frame.
const page = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>waiting</title><body style="margin:0;font:20px sans-serif;display:grid;place-items:center;height:100vh;background:#f4f7fb">
<div id="zone">Drop files here</div>
<script>
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); const names = [...e.dataTransfer.files].map(f => f.name + ':' + f.size).join(','); document.title = 'dropped ' + names; document.getElementById('zone').textContent = 'Got ' + names; });
</script>`);
});
await new Promise((r) => page.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${page.address().port}/drop.html`;

const library = join(root, 'Library');
const store = new Store(library);
const board = store.createBoard({ name: 'Telegram' });
const picture = await store.importAsset({
  bytes: await scene(600, 420, '#11998e', '#38ef7d'),
  name: 'Board sketch.png',
});
store.patchBoard({
  id: board.id,
  revision: 0,
  upserts: [
    {
      id: 'tg',
      type: 'file',
      text: 'Telegram',
      file: { path: '', kind: 'telegram' },
      x: 40,
      y: 40,
      width: 940,
      height: 660,
      z: 1,
    },
    {
      id: 'tg2',
      type: 'file',
      text: 'Telegram',
      file: { path: '', kind: 'telegram' },
      x: 1040,
      y: 40,
      width: 640,
      height: 560,
      z: 2,
    },
    {
      id: 'pic',
      type: 'image',
      assetId: picture.id,
      imageTitle: 'Board sketch',
      x: 40,
      y: 760,
      width: 240,
      height: 168,
      z: 3,
    },
    {
      id: 'web',
      type: 'browser',
      url: pageUrl,
      text: '',
      x: 1040,
      y: 660,
      width: 640,
      height: 300,
      z: 4,
    },
  ],
  camera: { x: 120, y: 20, zoom: 0.62 },
});
store.setLastBoard({ id: board.id });
store.close();

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const env = {
  ...process.env,
  CANVAS_DATA_DIR: library,
  TERRA_EXTENSIONS_DIR: join(root, 'Extensions'),
  TERRA_EXTENSIONS_SOURCE: resolve('release/extensions'),
  TERRA_TELEGRAM_FAKE: resolve('scripts/fixtures/fake-tdlib.cjs'),
  TERRA_TELEGRAM_FAKE_MEDIA: mediaDir,
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.CANVAS_DEV_URL;
const child = spawn(
  require('electron'),
  [
    resolve('.'),
    `--remote-debugging-port=${port}`,
    '--disable-renderer-backgrounding',
    // A built-in stand-in microphone (a beep) for the voice message.
    '--use-fake-device-for-media-stream',
    '--disable-backgrounding-occluded-windows',
  ],
  { env, stdio: process.env.TERRA_TELEGRAM_DEBUG ? 'inherit' : 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(100);
  }
  throw Error('Timed out: ' + label);
}
let socket,
  seq = 0;
const pending = new Map(),
  errors = [];
function send(method, params = {}) {
  return new Promise((done, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(method + ' timed out'));
    }, 15000);
    pending.set(id, { resolve: (v) => (clearTimeout(timer), done(v)), reject });
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
const textOf = (selector) =>
  read(`document.querySelector(${JSON.stringify(selector)})?.innerText || ''`);
async function mouse(type, x, y, buttons = 0, clickCount = 1, button) {
  await send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: button ?? (type === 'mouseMoved' && !buttons ? 'none' : 'left'),
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
async function click(selector, count = 1) {
  const r = await until(() => rect(selector), selector);
  await clickAt(r.x + r.width / 2, r.y + r.height / 2, count);
}
// Clicks the element (matching selector) whose text includes `text`.
async function clickText(selector, text) {
  const r = await until(
    () =>
      read(
        `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.innerText.includes(${JSON.stringify(text)}));if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
      ),
    `${selector} "${text}"`,
  );
  await clickAt(r.x + r.width / 2, r.y + r.height / 2);
}
async function drag(from, to, steps = 14) {
  await mouse('mouseMoved', from.x, from.y);
  await mouse('mousePressed', from.x, from.y, 1);
  // A person holds the button a moment before moving.
  await sleep(120);
  for (let i = 1; i <= steps; i++) {
    await mouse(
      'mouseMoved',
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
      1,
    );
    await sleep(16);
  }
  await sleep(120);
  await mouse('mouseReleased', to.x, to.y, 0);
}
async function key(name, code, windowsVirtualKeyCode) {
  for (const type of ['rawKeyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode });
}
async function type(selector, value) {
  await click(selector);
  await send('Input.insertText', { text: value });
  // A field that appeared a moment ago may not have taken focus yet: again.
  if (
    !(await read(
      `(document.querySelector(${JSON.stringify(selector)})?.value || '').includes(${JSON.stringify(value)})`,
    ))
  ) {
    await sleep(250);
    await click(selector);
    await send('Input.insertText', { text: value });
  }
}
const objects = async () =>
  (await read(`window.canvas.invoke('loadBoard',{id:${JSON.stringify(board.id)}})`)).objects;
const shots = [];
const screenshot = async (name) => {
  await sleep(250);
  const file = join(root, name);
  fs.writeFileSync(
    file,
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'),
  );
  shots.push(file);
};
// A sharp close-up of one element (rendered at `scale`).
const closeUp = async (selector, name, scale = 2.2) => {
  await sleep(250);
  const r = await rect(selector);
  const file = join(root, name);
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale },
  });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  shots.push(file);
};
// A board point on screen.
async function screenAt(x, y) {
  const host = await rect('.canvas-surface');
  return { x: host.x + 120 + x * 0.62, y: host.y + 20 + y * 0.62 };
}

try {
  const target = await until(
    async () => {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      return list.find((t) => t.type === 'page' && t.url.startsWith('canvas-app://'));
    },
    'app page',
    30000,
  );
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((socket.onopen = r), (socket.onerror = j)));
  socket.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown')
      errors.push(
        m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text,
      );
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // 1. Not installed yet: the frame offers the extension, or Telegram Web.
  await until(
    async () => (await textOf('.canvas-telegram[data-file-id="tg"]')).includes('Install Telegram'),
    'install offer',
  );
  await screenshot('01-install.png');
  await closeUp('.canvas-telegram[data-file-id="tg"]', 'closeup-1-install.png');

  // 2. Telegram Web instead: the second frame becomes a browser frame.
  await until(
    () => rect('.canvas-telegram[data-file-id="tg2"] .tg-alternative button'),
    'Telegram Web button',
  );
  await click('.canvas-telegram[data-file-id="tg2"] .tg-alternative button');
  const web = await until(
    async () =>
      (await objects()).find((o) => o.type === 'browser' && o.url?.includes('web.telegram.org')),
    'Telegram Web frame',
  );
  assert.equal(web.width, 640);
  assert.ok(!(await objects()).some((o) => o.id === 'tg2'), 'the Telegram frame was replaced');
  await sleep(6000);
  await screenshot('02-telegram-web.png');

  // 3. Install the extension from the frame.
  await click('.canvas-telegram[data-file-id="tg"] .tg-button.primary');
  await until(
    async () => (await textOf('.canvas-telegram[data-file-id="tg"]')).includes('API hash'),
    'API key form',
    60000,
  );
  assert.ok(fs.existsSync(join(root, 'Extensions', 'telegram', 'tdjson.dll')), 'TDLib installed');
  await screenshot('03-api-keys.png');

  // 4. An API ID: kept encrypted, never in the board.
  await type('.canvas-telegram[data-file-id="tg"] input[placeholder="1234567"]', '1234567');
  await type(
    '.canvas-telegram[data-file-id="tg"] input[placeholder^="32"]',
    '0123456789abcdef0123456789abcdef',
  );
  await click('.canvas-telegram[data-file-id="tg"] .tg-form .tg-button.primary');
  await until(() => rect('.canvas-telegram[data-file-id="tg"] .tg-qr'), 'QR code');
  const saved = fs.readFileSync(join(library, 'telegram', 'credentials.bin'));
  assert.ok(!saved.toString('latin1').includes('0123456789abcdef'), 'the API hash is encrypted');
  const kept = (await objects()).find((o) => o.id === 'tg');
  assert.deepEqual(kept.file, { path: '', kind: 'telegram' });
  await screenshot('04-sign-in-qr.png');
  await closeUp('.canvas-telegram[data-file-id="tg"]', 'closeup-2-sign-in.png');

  // 5. Scanned: the chats.
  await until(
    async () =>
      (await read(
        `document.querySelectorAll('.canvas-telegram[data-file-id="tg"] .tg-chat').length`,
      )) >= 5,
    'chat list',
    15000,
  );
  await screenshot('05-chats.png');

  // 6. A chat.
  await clickText('.canvas-telegram[data-file-id="tg"] .tg-chat', 'Design team');
  await until(
    async () => (await read(`document.querySelectorAll('.tg-bubble').length`)) >= 5,
    'messages',
  );
  await until(
    () => read(`[...document.querySelectorAll('.tg-photo')].some(i=>i.complete&&i.naturalWidth>0)`),
    'photo',
  );
  await screenshot('06-chat.png');
  await closeUp('.canvas-telegram[data-file-id="tg"]', 'closeup-3-chat.png');
  const unread = await read(
    `document.querySelector('.tg-chat[data-active] .tg-badge')?.innerText || ''`,
  );
  assert.equal(unread, '', 'an open chat on screen is marked as read');

  // Profile photos (kept beside TDLib's database) show.
  await until(
    () =>
      read(
        `[...document.querySelectorAll('.tg-chat .tg-avatar img')].some(i=>i.src.startsWith('terra-telegram:')&&i.naturalWidth>0)`,
      ),
    'profile photos',
  );

  // Your own chat is Saved Messages, pinned, with a bookmark.
  await until(
    async () => (await textOf('.tg-chat .tg-chat-title')) === 'Saved Messages',
    'Saved Messages first',
  );
  assert.ok(await rect('.tg-chat .tg-avatar.tg-saved'), 'bookmark picture');

  // 7. A board picture dragged onto another chat in the list: that chat opens
  // with the picture in its send dialog; sending puts it in the chat.
  const pic = await screenAt(160, 844);
  const maria = await until(
    () =>
      read(
        `(()=>{const e=[...document.querySelectorAll('.tg-chat')].find(e=>e.innerText.includes('Maria Lopez'));if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
      ),
    'Maria in the list',
  );
  await drag(pic, { x: maria.x + maria.width / 2, y: maria.y + maria.height / 2 });
  await until(() => rect('.tg-dialog'), 'send dialog');
  assert.match(await textOf('.tg-dialog'), /Board sketch\.png/);
  assert.match(await textOf('.tg-chat-head'), /Maria Lopez/);
  assert.ok(
    (await objects()).find((o) => o.id === 'pic').x === 40,
    'the picture stays on the board',
  );
  await type('.tg-dialog-caption input', 'From the board');
  await screenshot('07-attached.png');
  await closeUp('.canvas-telegram[data-file-id="tg"]', 'closeup-5-send-dialog.png');
  await clickText('.tg-dialog-actions button', 'Send');
  await until(async () => !(await rect('.tg-dialog')), 'sent');
  // The upload shows its progress, then the message is sent.
  await until(async () => /Uploading \d+%/.test(await textOf('.tg-upload')), 'upload progress');
  await closeUp('.canvas-telegram[data-file-id="tg"]', 'closeup-15-uploading.png');
  await until(async () => !(await rect('.tg-upload')), 'upload done', 10000);
  await until(
    async () => (await textOf('.tg-messages')).includes('From the board'),
    'sent message shows',
  );
  await screenshot('08-sent.png');

  // A file from Explorer dropped on a chat in the list opens the same dialog.
  const alex = await until(
    () =>
      read(
        `(()=>{const e=[...document.querySelectorAll('.tg-chat')].find(e=>e.innerText.includes('Alex Kim'));if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      ),
    'Alex in the list',
  );
  const pdf = join(mediaDir, 'brief.pdf');
  for (const type of ['dragEnter', 'dragOver', 'drop'])
    await send('Input.dispatchDragEvent', {
      type,
      x: alex.x,
      y: alex.y,
      data: { items: [], files: [pdf], dragOperationsMask: 1 },
    });
  await until(() => rect('.tg-dialog'), 'dialog for a dropped file');
  assert.match(await textOf('.tg-dialog'), /Send as a file[\s\S]*brief\.pdf/);
  assert.match(await textOf('.tg-chat-head'), /Alex Kim/);
  await clickText('.tg-dialog-actions button', 'Send');
  await until(async () => (await textOf('.tg-messages')).includes('brief.pdf'), 'file sent');

  // A voice message, from Chromium's stand-in microphone.
  await click('.tg-mic');
  await until(() => rect('.tg-recording'), 'recording');
  await sleep(1800);
  await screenshot('08b-recording.png');
  await click('.tg-recording .tg-send');
  await until(
    () => read(`document.querySelectorAll('.tg-row[data-out] .tg-voice').length > 0`),
    'voice message sent',
    20000,
  );
  await click('.tg-row[data-out] .tg-voice-play');
  await until(
    () => read(`[...document.querySelectorAll('audio')].some(a=>!a.paused)`),
    'voice plays',
  );
  await closeUp('.canvas-telegram[data-file-id="tg"]', 'closeup-6-voice.png');

  // Back to the group chat for the next steps.
  await clickText('.canvas-telegram[data-file-id="tg"] .tg-chat', 'Design team');
  await until(
    () => read(`[...document.querySelectorAll('.tg-photo')].some(i=>i.naturalWidth>0)`),
    'group photos',
  );

  // The message menu: reactions, edit, pin, forward — what TDLib allows.
  const own = async () =>
    read(
      `(()=>{const e=[...document.querySelectorAll('.tg-row[data-out] .tg-bubble')].find(e=>e.innerText.includes('pin it'));if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
  const rightClick = async ({ x, y }) => {
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, 2, 1, 'right');
    await mouse('mouseReleased', x, y, 0, 1, 'right');
  };
  await rightClick(await until(own, 'own message'));
  await until(() => rect('.tg-menu-reactions'), 'reactions in the menu');
  const items = await read(
    `[...document.querySelectorAll('.context-menu button[role=menuitem]')].map(b=>b.innerText)`,
  );
  for (const label of ['Reply', 'Edit', 'Copy text', 'Forward', 'Pin', 'Delete'])
    assert.ok(items.includes(label), `menu has ${label}: ${items}`);
  assert.equal(
    await read(`document.querySelectorAll('.context-menu hr').length`),
    2,
    'dividers only between groups',
  );
  {
    const m = await rect('.context-menu');
    await sleep(200);
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: m.x - 8, y: m.y - 8, width: m.width + 16, height: m.height + 16, scale: 2 },
    });
    fs.writeFileSync(join(root, 'closeup-7-message-menu.png'), Buffer.from(shot.data, 'base64'));
  }
  await click('.tg-menu-reactions button');
  await until(() => rect('.tg-reactions button[data-chosen]'), 'reaction under the message');
  // Edit.
  await rightClick(await own());
  await clickText('.context-menu button', 'Edit');
  await until(async () => (await textOf('.tg-composer')).includes('Edit message'), 'edit bar');
  await click('.tg-composer textarea');
  await key('End', 'End', 35);
  await send('Input.insertText', { text: ' (edited here)' });
  await key('Enter', 'Enter', 13);
  await until(async () => (await textOf('.tg-messages')).includes('(edited here)'), 'edited');
  // Pin: the pinned bar shows it.
  await rightClick(await own());
  await clickText('.context-menu button', 'Pin');
  await until(async () => (await textOf('.tg-pinned-bar')).includes('edited here'), 'pinned bar');
  await closeUp('.canvas-telegram[data-file-id="tg"]', 'closeup-8-reaction-edit-pin.png');
  // Forward to Dana: that chat opens with it.
  await rightClick(await own());
  await clickText('.context-menu button', 'Forward');
  await until(() => rect('.tg-forward'), 'forward dialog');
  await clickText('.tg-forward-chat', 'Dana Wu');
  await until(async () => (await textOf('.tg-chat-head')).includes('Dana Wu'), 'forwarded chat');
  await until(async () => (await textOf('.tg-messages')).includes('Forwarded'), 'forwarded');

  // The chat menu: archive a chat, then find it under Archived; the Work folder.
  const row = (name) =>
    read(
      `(()=>{const e=[...document.querySelectorAll('.tg-chat')].find(e=>e.innerText.includes(${JSON.stringify(name)}));if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
  {
    // Nothing selected on the board, so no toolbar lies over the chats.
    const empty = await screenAt(900, 1350);
    await clickAt(empty.x, empty.y);
  }
  await rightClick(await until(() => row('Family'), 'Family'));
  const chatItems = await read(
    `[...document.querySelectorAll('.context-menu button[role=menuitem]')].map(b=>b.innerText)`,
  );
  for (const label of ['Pin', 'Archive', 'Unmute', 'Mark as read', 'Clear history', 'Leave group'])
    assert.ok(chatItems.includes(label), `chat menu has ${label}: ${chatItems}`);
  {
    const m = await rect('.context-menu');
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: m.x - 8, y: m.y - 8, width: m.width + 16, height: m.height + 16, scale: 2 },
    });
    fs.writeFileSync(join(root, 'closeup-9-chat-menu.png'), Buffer.from(shot.data, 'base64'));
  }
  await clickText('.context-menu button', 'Archive');
  await until(async () => !(await row('Family')), 'archived away');
  await clickText('.tg-tabs button', 'Archived');
  await until(() => row('Family'), 'in the archive');
  await clickText('.tg-tabs button', 'Work');
  await until(async () => (await row('Design team')) && !(await row('Maria Lopez')), 'Work folder');
  await clickText('.tg-tabs button', 'All chats');
  await until(() => row('Maria Lopez'), 'all chats again');

  // Text size from the frame menu.
  await click('.canvas-telegram[data-file-id="tg"] .cf-header .cf-button');
  await clickText('.context-menu button', 'Text: Larger');
  await until(
    () => read(`getComputedStyle(document.querySelector('.tg-text')).fontSize === '20px'`),
    'larger text',
  );
  await click('.canvas-telegram[data-file-id="tg"] .cf-header .cf-button');
  await clickText('.context-menu button', 'Text: Medium');

  // Polls: a vote shows the results.
  await clickText('.canvas-telegram[data-file-id="tg"] .tg-chat', 'Design team');
  await until(() => rect('.tg-poll-choice'), 'poll choices');
  await read(`document.querySelector('.tg-poll-choice').scrollIntoView({block:'center'})`);
  await clickText('.tg-poll-choice', 'Wednesday');
  await until(() => rect('.tg-poll-option[data-chosen]'), 'poll results');
  assert.match(await textOf('.tg-poll-option[data-chosen]'), /Wednesday/);
  await closeUp('.canvas-telegram[data-file-id="tg"]', 'closeup-10-poll.png');

  // Searching the chat: a result is shown, highlighted.
  await click('[aria-label="Search this chat"]');
  await type('.tg-search-panel input', 'brief');
  await until(() => rect('.tg-search-result'), 'search results');
  await click('.tg-search-result');
  await until(() => rect('[data-message-id][data-found]'), 'found message');
  await click('[aria-label="Close search"]');

  // Emoji go into the message; stickers and saved GIFs are sent.
  await click('[aria-label="Emoji, stickers and GIFs"]');
  await until(() => rect('.tg-picker'), 'picker');
  await clickText('.tg-emoji-grid button', '😀');
  assert.equal(await read(`document.querySelector('.tg-composer textarea').value`), '😀');
  await clickText('.tg-picker .tg-tabs button', 'Stickers');
  await clickText('.tg-sticker-sets button', 'Terra');
  await until(
    () => read(`[...document.querySelectorAll('.tg-sticker-cell img')].some(i=>i.naturalWidth>0)`),
    'stickers',
  );
  await closeUp('.canvas-telegram[data-file-id="tg"]', 'closeup-11-stickers.png');
  await click('.tg-sticker-cell');
  await until(() => rect('.tg-row[data-out] .tg-sticker'), 'sticker sent');
  await click('[aria-label="Emoji, stickers and GIFs"]');
  await clickText('.tg-picker .tg-tabs button', 'GIFs');
  await until(() => rect('.tg-gif-cell'), 'saved GIFs');
  await click('.tg-gif-cell');
  await until(
    () =>
      read(
        `[...document.querySelectorAll('.tg-row[data-out]')].pop()?.querySelector('.tg-visual') != null`,
      ),
    'GIF sent',
  );

  // A scheduled message: right-click Send, pick a time, then send it now.
  await click('.tg-composer textarea');
  await key('End', 'End', 35);
  await send('Input.insertText', { text: ' later' });
  {
    const sendButton = await rect('.tg-send');
    await rightClick({ x: sendButton.x + 10, y: sendButton.y + 10 });
  }
  await clickText('.context-menu button', 'Schedule message');
  await until(() => rect('input[type="datetime-local"]'), 'schedule dialog');
  await clickText('.tg-dialog-actions button', 'Schedule');
  await until(async () => (await textOf('.tg-composer')).includes('Scheduled'), 'scheduled');
  assert.ok(!(await textOf('.tg-messages')).includes('😀 later'), 'not in the chat yet');
  await click('[aria-label="Scheduled messages"]');
  await until(async () => (await textOf('.tg-dialog')).includes('😀 later'), 'scheduled list');
  await click('.tg-scheduled [aria-label="Send now"]');
  await until(async () => (await textOf('.tg-messages')).includes('😀 later'), 'sent now');
  await clickText('.tg-dialog-actions button', 'Close');

  // A bot: its buttons answer, its keyboard sends.
  await clickText('.canvas-telegram[data-file-id="tg"] .tg-chat', 'Weather Bot');
  await until(() => rect('.tg-reply-keyboard'), 'bot keyboard');
  await clickText('.tg-keyboard button', 'Refresh');
  await until(async () => (await textOf('.tg-notice')).includes('15°C'), 'bot answer');
  await closeUp('.canvas-telegram[data-file-id="tg"]', 'closeup-12-bot.png');
  await clickText('.tg-reply-keyboard button', 'Today');
  await until(
    async () =>
      (
        await read(`[...document.querySelectorAll('.tg-row[data-out]')].pop()?.innerText || ''`)
      ).includes('Today'),
    'keyboard text sent',
  );

  // A new group with a contact.
  await click('[aria-label="New group or channel"]');
  await clickText('.context-menu button', 'New group');
  await type('.tg-dialog-caption input', 'Board crew');
  await until(() => rect('.tg-forward-chat input'), 'contacts');
  await click('.tg-forward-chat input');
  await clickText('.tg-dialog-actions button', 'Create');
  await until(async () => (await textOf('.tg-chat-head')).includes('Board crew'), 'new group open');

  // Stories: the bar over the chats, and watching them.
  await until(() => rect('.tg-story'), 'stories bar');
  await click('.tg-story');
  await until(
    () => read(`[...document.querySelectorAll('.tg-story-media img')].some(i=>i.naturalWidth>0)`),
    'story shown',
  );
  await closeUp('.canvas-telegram[data-file-id="tg"]', 'closeup-13-story.png');
  await click('[aria-label="Close stories"]');

  // A call coming in: Terra can decline it.
  await clickText('.canvas-telegram[data-file-id="tg"] .tg-chat', 'Maria Lopez');
  await type('.tg-composer textarea', 'call me');
  await key('Enter', 'Enter', 13);
  await until(() => rect('.tg-call-banner'), 'incoming call');
  await closeUp('.canvas-telegram[data-file-id="tg"]', 'closeup-14-call.png');
  await clickText('.tg-call-banner button', 'Decline');
  await until(async () => !(await rect('.tg-call-banner')), 'call declined');

  // Pinned to the screen: the chats run in the pin; the frame says so.
  await clickText('.canvas-telegram[data-file-id="tg"] .tg-chat', 'Design team');
  await click('.canvas-telegram .cf-header .cf-title');
  {
    const title = await rect('.canvas-telegram .cf-header .cf-title');
    await rightClick({ x: title.x + 30, y: title.y + title.height / 2 });
    await clickText('.context-menu button', 'Pin to screen');
  }
  await until(
    () => read(`document.querySelectorAll('.screen-pin .tg-pinned .tg-chat').length >= 5`),
    'chats in the pinned window',
  );
  assert.match(await textOf('.canvas-folder.canvas-telegram'), /pinned to the screen/);
  await screenshot('11-pinned.png');
  await click('.screen-pin [aria-label="Unpin from screen"]');
  await until(
    () =>
      read(
        `!document.querySelector('.screen-pin') && document.querySelectorAll('.canvas-folder.canvas-telegram[data-file-id="tg"] .tg-chat').length >= 5`,
      ),
    'back on the board',
  );
  await clickText('.canvas-telegram[data-file-id="tg"] .tg-chat', 'Design team');
  await until(
    () => read(`[...document.querySelectorAll('.tg-photo')].some(i=>i.naturalWidth>0)`),
    'group photos again',
  );

  // 8. A Telegram photo added to the board from its menu.
  const before = (await objects()).filter((o) => o.type === 'image').length;
  // The newest photo, in view at the bottom of the chat.
  const photo = await until(
    () =>
      read(
        `(()=>{const e=[...document.querySelectorAll('.tg-photo')].pop();if(!e||!e.naturalWidth)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
      ),
    'photo bubble',
  );
  await mouse('mouseMoved', photo.x + 20, photo.y + 20);
  await mouse('mousePressed', photo.x + 20, photo.y + 20, 2, 1, 'right');
  await mouse('mouseReleased', photo.x + 20, photo.y + 20, 0, 1, 'right');
  await clickText('.context-menu button', 'Add to the board');
  await until(
    async () => (await objects()).filter((o) => o.type === 'image').length > before,
    'photo on the board',
  );

  // 9. A Telegram file and text dropped on the board (drags from a frame).
  const empty = await screenAt(2000, 700);
  const dragData = (items) => ({ items, dragOperationsMask: 1 });
  for (const type of ['dragEnter', 'dragOver', 'drop'])
    await send('Input.dispatchDragEvent', {
      type,
      x: empty.x,
      y: empty.y,
      data: dragData([
        {
          mimeType: 'application/x-terra-telegram-file',
          data: JSON.stringify({ fileId: 32, name: 'Photo.png' }),
        },
      ]),
    });
  await until(
    async () => (await objects()).filter((o) => o.type === 'image').length > before + 1,
    'dragged photo on the board',
  );
  const textAt = await screenAt(330, 1260);
  for (const type of ['dragEnter', 'dragOver', 'drop'])
    await send('Input.dispatchDragEvent', {
      type,
      x: textAt.x,
      y: textAt.y,
      data: dragData([{ mimeType: 'text/plain', data: 'Note from Telegram' }]),
    });
  await until(
    async () => (await objects()).some((o) => o.type === 'text' && o.text === 'Note from Telegram'),
    'text on the board',
  );
  await screenshot('09-added-to-board.png');

  // 10. A board picture dropped into a running browser frame's page.
  await key('Escape', 'Escape', 27);
  const frame = await screenAt(1500, 900);
  await clickAt(frame.x, frame.y, 2);
  await until(
    () =>
      read(
        `(()=>{const w=document.querySelector('.board-browser-live webview');try{return w&&w.getTitle()==='waiting'}catch{return false}})()`,
      ),
    'drop page',
    20000,
  );
  const target2 = await rect('.board-browser-live webview');
  const pic2 = await screenAt(160, 844);
  await drag(pic2, { x: target2.x + target2.width / 2, y: target2.y + target2.height / 2 });
  const title = await until(
    () =>
      read(
        `(()=>{const t=document.querySelector('.board-browser-live webview')?.getTitle();return t&&t.startsWith('dropped')?t:null})()`,
      ),
    'drop in page',
    15000,
  );
  assert.match(title, /Board sketch\.png:\d+/);
  await screenshot('10-browser-drop.png');

  // 11. Signing out and removing the API ID.
  await click('.canvas-telegram[data-file-id="tg"] .cf-header .cf-button');
  await clickText('.context-menu button', 'remove the API ID');
  await until(
    async () => (await textOf('.canvas-telegram[data-file-id="tg"]')).includes('API hash'),
    'signed out',
  );
  assert.ok(!fs.existsSync(join(library, 'telegram', 'credentials.bin')), 'the API ID is gone');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, folder: root, screenshots: shots }, null, 2));
} catch (error) {
  await screenshot('failure.png').catch(() => {});
  // Pictures that didn't load, and what their addresses answer.
  console.error(
    await read(
      `Promise.all([31,32,64,14].map(id=>new Promise(done=>{const i=new Image();i.onload=()=>done(id+' ok '+i.naturalWidth);i.onerror=()=>done(id+' error');i.src='terra-telegram://file/'+id+'?'+Math.random();}))).then(async r=>[...r, JSON.stringify(await window.canvas.telegram.invoke({'@type':'getFile',file_id:31}))])`,
    ).catch((e) => e.message),
  );
  console.error(error, errors);
  console.log(JSON.stringify({ ok: false, folder: root, screenshots: shots }, null, 2));
  process.exitCode = 1;
} finally {
  socket?.close();
  child.kill();
  page.close();
}
