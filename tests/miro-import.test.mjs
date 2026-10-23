import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
const require = createRequire(import.meta.url);
const { MiroClient, boardIdFrom, convertBoard, fitCamera, importBoard, richText, wrappedLines } =
  require('../electron/miro-import.cjs');
const { Store, objectValue } = require('../electron/store.cjs');

test('Miro text HTML becomes plain text with marks', () => {
  const r = richText(
    '<p><strong>Bold</strong> and <a href="https://x.dev">link</a>&nbsp;&amp; <span style="color:rgb(26,26,26)">ink</span> <span style="color:rgb(230,0,0)">red</span></p><p>Second</p>',
  );
  assert.equal(r.text, 'Bold and link & ink red\nSecond');
  assert.deepEqual(r.marks, [
    { start: 0, end: 4, bold: true },
    { start: 9, end: 13, underline: true, color: '#2563eb' },
    { start: 20, end: 23, color: '#e60000' },
  ]);
  const list = richText(
    '<p>Steps:</p><ol><li data-list="ordered"><span class="ql-ui"></span>one</li><li data-list="ordered"><span class="ql-ui"></span>two</li></ol><ul><li>dot</li></ul>',
  );
  assert.equal(list.text, 'Steps:\n1. one\n2. two\n• dot');
  // Offsets count UTF-16 code units, like the app's own strings.
  const emoji = richText('<p>😀 <strong>hi</strong></p>');
  assert.deepEqual(emoji.marks, [{ start: 3, end: 5, bold: true }]);
});

test('board links and ids both name a board', () => {
  assert.equal(boardIdFrom('https://miro.com/app/board/uXjVHvEvTqg=/?share_link_id=1'), 'uXjVHvEvTqg=');
  assert.equal(boardIdFrom('https://miro.com/app/board/uXjVHvEvTqg%3D/'), 'uXjVHvEvTqg=');
  assert.equal(boardIdFrom(' uXjVHqFzTpc= '), 'uXjVHqFzTpc=');
});

test('text wraps at the Miro width', () => {
  assert.equal(wrappedLines('short', 16, 400), 1);
  assert.equal(wrappedLines('one two three four five six seven eight nine ten', 16, 120) > 2, true);
  assert.equal(wrappedLines('a\nb', 16, 400), 2);
});

const frame = {
  id: '1',
  type: 'frame',
  data: { title: 'Intro &amp; more' },
  geometry: { width: 1000, height: 600 },
  position: { x: 500, y: 300, origin: 'center', relativeTo: 'canvas_center' },
};
const inFrame = (id, type, x, y, extra) => ({
  id,
  type,
  parent: { id: '1' },
  position: { x, y, origin: 'center', relativeTo: 'parent_top_left' },
  ...extra,
});
const items = [
  inFrame('2', 'image', 200, 100, {
    data: { imageUrl: 'https://api.miro.com/v2/boards/b/resources/images/77?format=preview&redirect=false' },
    geometry: { width: 300, height: 150 },
  }),
  inFrame('3', 'text', 600, 50, {
    data: { content: '<p><strong>Title</strong> text</p>' },
    style: { fontSize: '24', textAlign: 'center', color: '#1a1a1a' },
    geometry: { width: 200 },
  }),
  frame,
  {
    id: '4',
    type: 'sticky_note',
    data: { content: '<p>Idea</p>' },
    style: { fillColor: 'light_yellow' },
    geometry: { width: 199, height: 228 },
    position: { x: 1500, y: 100, relativeTo: 'canvas_center' },
  },
  {
    id: '5',
    type: 'shape',
    data: { shape: 'circle', content: '<p>Go</p>' },
    style: { fillColor: '#ff0000', fontSize: '14' },
    geometry: { width: 100, height: 100, rotation: -90 },
    position: { x: 1500, y: 400, relativeTo: 'canvas_center' },
  },
  inFrame('6', 'code', 500, 400, {
    data: { code: 'local x &#61; 1\r\n\tprint(x)' },
    geometry: { width: 300, height: 100 },
  }),
  {
    id: '7',
    type: 'embed',
    data: { url: 'https://youtube.com/watch?v=1', title: 'Video' },
    geometry: { width: 320, height: 180 },
    position: { x: -400, y: 0, relativeTo: 'canvas_center' },
  },
  { id: '8', type: 'paint', position: { x: 0, y: 0, relativeTo: 'canvas_center' } },
  { id: '9', type: 'mindmap_node', position: { x: 0, y: 0, relativeTo: 'canvas_center' } },
  inFrame('10', 'image', 800, 500, {
    data: { imageUrl: 'https://api.miro.com/v2/boards/b/resources/images/78?format=preview' },
    geometry: { width: 50, height: 50 },
  }),
];
const connectors = [
  {
    id: '20',
    shape: 'curved',
    startItem: { id: '2', position: { x: '100%', y: '50%' } },
    endItem: { id: '3', position: { x: '0%', y: '50%' } },
    style: { endStrokeCap: 'rounded_stealth', strokeWidth: '2.0', strokeColor: '#333333' },
  },
  { id: '21', shape: 'straight', style: {} },
];

test('Miro items convert to valid Terra objects in place', () => {
  const { objects, skipped } = convertBoard({ items, connectors, assets: new Map([['2', 'a'.repeat(64)]]) });
  for (const o of objects) objectValue(o);
  const by = Object.fromEntries(objects.map((o) => [o.id, o]));
  assert.equal(by['miro-1'].type, 'frame');
  assert.equal(by['miro-1'].text, 'Intro & more');
  assert.deepEqual([by['miro-1'].x, by['miro-1'].y], [0, 0]);
  // Child centers are relative to the frame's top-left corner.
  assert.deepEqual([by['miro-2'].x, by['miro-2'].y, by['miro-2'].width], [50, 25, 300]);
  assert.ok(by['miro-2'].z > by['miro-1'].z);
  const t = by['miro-3'];
  assert.equal(t.text, 'Title text');
  assert.equal(t.centerX, true);
  assert.equal(t.color, undefined);
  assert.ok(Math.abs(t.x + t.width / 2 - 600) < 1e-9 && Math.abs(t.y + t.height / 2 - 50) < 1e-9);
  assert.ok(t.z > by['miro-2'].z);
  assert.equal(by['miro-4'].type, 'note');
  assert.equal(by['miro-4'].color, '#fff9b1');
  assert.equal(by['miro-5'].type, 'ellipse');
  assert.equal(by['miro-5'].rotation, 270);
  assert.equal(by['miro-6'].text, 'local x = 1\n    print(x)');
  assert.equal(by['miro-6-bg'].type, 'rect');
  assert.equal(by['miro-7'].type, 'link');
  assert.equal(by['miro-20'].type, 'arrow');
  assert.equal(by['miro-20'].arrow.line, 'curve');
  assert.deepEqual(skipped, { drawings: 1, arrows: 1, images: 1, other: 1 });
  const camera = fitCamera(objects);
  assert.ok(camera.zoom > 0.01 && camera.zoom < 16);
});

test('a Miro board imports through the API into a new board', async () => {
  mkdirSync(resolve('.local-test'), { recursive: true });
  const store = new Store(mkdtempSync(resolve('.local-test/miro-')));
  const png = await sharp({ create: { width: 4, height: 2, channels: 3, background: '#3366ff' } })
    .png()
    .toBuffer();
  const seen = [];
  const reply = (body, status = 200) => ({
    ok: status < 400,
    status,
    headers: { get: () => null },
    json: async () => body,
    arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
  });
  const fetch = async (url, init) => {
    seen.push([url, init.headers.Authorization]);
    if (url === 'https://cdn.example/img.png') return reply(null);
    if (!url.startsWith('https://api.miro.com/v2/')) throw Error('unexpected ' + url);
    if (init.headers.Authorization !== 'Bearer tok') return reply({}, 401);
    if (url.endsWith('/boards/b%3D')) return reply({ id: 'b=', name: 'Sketches' });
    if (url.includes('/items?')) {
      const page = url.includes('cursor=') ? items.slice(5) : items.slice(0, 5);
      return reply({ data: page, cursor: url.includes('cursor=') ? undefined : 'next' });
    }
    if (url.includes('/connectors?')) return reply({ data: connectors });
    if (url.includes('/resources/images/77')) {
      assert.match(url, /format=original/);
      return reply({ type: 'image/png', url: 'https://cdn.example/img.png' });
    }
    if (url.includes('/resources/images/78')) return reply({}, 500);
    throw Error('unexpected ' + url);
  };
  const progress = [];
  const call = async (command, args) => store[command](args);
  const result = await importBoard({
    client: new MiroClient('tok', { fetch }),
    boardId: 'b=',
    call,
    onProgress: (p) => progress.push(p.phase),
  });
  assert.equal(result.board.name, 'Sketches');
  assert.deepEqual(result.skipped, { drawings: 1, arrows: 1, images: 1, other: 1 });
  const doc = store.loadBoard({ id: result.board.id });
  assert.equal(doc.objects.length, result.objects);
  const image = doc.objects.find((o) => o.id === 'miro-2');
  assert.equal(store.asset({ id: image.assetId, variant: 'original' }).mime, 'image/png');
  // The image file itself is fetched without the Miro token.
  assert.equal(seen.find(([u]) => u === 'https://cdn.example/img.png')[1], undefined);
  assert.deepEqual([...new Set(progress)], ['reading', 'images', 'saving']);
  await assert.rejects(
    importBoard({ client: new MiroClient('bad', { fetch }), boardId: 'b=', call }),
    /did not accept this access token/,
  );
  store.close();
});

test('boards list the token team plus teams learned from links', async () => {
  const asked = [];
  const reply = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
  const fetch = async (url) => {
    asked.push(url);
    if (url.endsWith('/v1/oauth-token')) return reply({ team: { id: 1, name: 'NL' } });
    if (url.includes('/boards/uX%3D')) return reply({ id: 'uX=', team: { id: 2, name: 'Kaban' } });
    if (url.includes('team_id=1')) return reply({ data: [], total: 0 });
    if (url.includes('team_id=2'))
      return reply({
        data: [
          { id: 'a', name: 'Old', modifiedAt: '2026-01-01T00:00:00Z' },
          { id: 'b', name: 'New', modifiedAt: '2026-09-01T00:00:00Z' },
        ],
        total: 2,
      });
    throw Error('unexpected ' + url);
  };
  const client = new MiroClient('tok', { fetch });
  assert.deepEqual((await client.boards()).boards, []);
  const team = await client.teamOf('uX=');
  assert.deepEqual(team, { id: '2', name: 'Kaban' });
  const r = await client.boards([team]);
  assert.deepEqual(r.boards.map((b) => [b.name, b.team]), [
    ['New', 'Kaban'],
    ['Old', 'Kaban'],
  ]);
  assert.deepEqual(r.teams, [
    { id: '1', name: 'NL' },
    { id: '2', name: 'Kaban' },
  ]);
});
