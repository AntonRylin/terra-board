import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const require = createRequire(import.meta.url);
const { McpService, settingsFile } = require('../electron/mcp-server.cjs');
const { Store } = require('../electron/store.cjs');
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const data = (r) => {
  assert.ok(!r.isError, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
async function fixture(services) {
  mkdirSync(resolve('.local-test'), { recursive: true });
  const root = mkdtempSync(resolve('.local-test/mcp-'));
  const store = new Store(root);
  const service = new McpService({
    root,
    call: (c, a) => (c === 'asset' ? store.readAsset(a) : store[c](a)),
    services,
  });
  const port = await freePort();
  assert.equal(service.status().enabled, false);
  assert.equal(service.status().running, false);
  await service.update({ enabled: true, port });
  assert.equal(service.status().running, true);
  const token = JSON.parse(readFileSync(settingsFile(root), 'utf8')).token;
  const client = new Client({ name: 'integration-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(service.status().url), {
      requestInit: { headers: { Authorization: 'Bearer ' + token } },
    }),
  );
  return {
    root,
    store,
    service,
    client,
    token,
    close: async () => {
      await client.close();
      await service.stop();
      store.close();
    },
  };
}
test('MCP interoperates with SDK: board/folder CRUD, complete object edits, stale revision, image upload/read and persistence', async () => {
  const f = await fixture();
  try {
    const call = async (name, args = {}) =>
      data(await f.client.callTool({ name, arguments: args }));
    const names = (await f.client.listTools()).tools.map((t) => t.name);
    assert.equal(names.length, 15);
    assert.ok(names.includes('read_board_history'));
    assert.ok(names.includes('share_board'));
    assert.ok(names.includes('edit_board'));
    const folder = await call('create_folder', { name: 'Research' });
    const board = await call('create_board', { name: 'AI board', folderId: folder.id });
    const o = {
      id: 'text',
      type: 'text',
      x: 10,
      y: 20,
      width: 400,
      height: 80,
      z: 1,
      text: 'Hello',
      bold: true,
      strikethrough: true,
    };
    const r = await call('edit_board', { id: board.id, revision: 0, upserts: [o] });
    assert.equal(r.revision, 1);
    const conflict = await f.client.callTool({
      name: 'edit_board',
      arguments: { id: board.id, revision: 0, deleted: ['text'] },
    });
    assert.equal(conflict.isError, true);
    const doc = await call('read_board', { id: board.id });
    assert.deepEqual(doc.objects, [o]);
    const png = await sharp({
      create: { width: 30, height: 20, channels: 3, background: '#ff3300' },
    })
      .png()
      .toBuffer();
    const asset = await call('import_media', { base64: png.toString('base64'), name: 'Photo.png' });
    const file = join(f.root, 'local-photo.png');
    writeFileSync(file, png);
    assert.equal((await call('import_media', { file })).id, asset.id);
    const image = await f.client.callTool({ name: 'read_asset', arguments: { id: asset.id } });
    assert.equal(image.content[1].type, 'image');
    assert.ok(Buffer.from(image.content[1].data, 'base64').length);
    const objects = [
      {
        id: 'picture',
        type: 'image',
        assetId: asset.id,
        x: 100,
        y: 150,
        width: 300,
        height: 200,
        z: 2,
        imageTitle: 'Las bebidas',
      },
    ];
    await call('edit_board', { id: board.id, revision: 1, upserts: objects });
    const page = await call('read_board', { id: board.id, limit: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.nextOffset, 1);
    assert.equal(
      (await call('read_board', { id: board.id, offset: 1, revision: page.revision })).objects
        .length,
      1,
    );
    // Search finds objects by their visible names and text, case-insensitively.
    const found = await call('read_board', { id: board.id, query: 'BEBIDAS' });
    assert.deepEqual(
      found.objects.map((o) => o.id),
      ['picture'],
    );
    assert.equal(found.total, 1);
    assert.equal(found.nextOffset, null);
    assert.deepEqual(
      (await call('read_board', { id: board.id, query: 'hello' })).objects.map((o) => o.id),
      ['text'],
    );
    assert.equal((await call('read_board', { id: board.id, query: 'nothing' })).total, 0);
    await call('update_board', {
      id: board.id,
      patch: { name: 'Renamed', icon: 'asset-' + asset.id, trashed: true },
    });
    assert.equal((await call('list_boards', { query: 'renamed' })).boards[0].trashed, true);
    await call('update_board', { id: board.id, patch: { trashed: false } });
    const duplicate = await call('duplicate_board', { id: board.id });
    assert.equal((await call('read_board', { id: duplicate.id })).objects.length, 2);
    await call('update_folder', { id: folder.id, patch: { name: 'New folder' } });
    await call('remove_folder', { id: folder.id });
    assert.equal((await call('list_boards')).folders.length, 0);
    await call('edit_board', { id: board.id, revision: 2, deleted: ['text'] });
    assert.equal((await call('read_board', { id: board.id })).objects.length, 1);
    const history = await call('read_board_history', { id: board.id, deletedOnly: true });
    assert.equal(history.entries.length, 1);
    assert.equal(history.entries[0].objectId, 'text');
    assert.equal(history.entries[0].source, 'ai');
    assert.equal(history.entries[0].onBoard, false);
    assert.equal(history.entries[0].before.id, 'text');
    const config = JSON.parse(readFileSync(settingsFile(f.root), 'utf8'));
    assert.equal(config.enabled, true);
    const reopened = new Store(f.root);
    assert.equal(reopened.loadBoard({ id: board.id }).objects[0].assetId, asset.id);
    reopened.close();
  } finally {
    await f.close();
  }
});
test('MCP can edit and copy existing gallery objects without losing their layout fields', async () => {
  const f = await fixture();
  try {
    const call = async (name, args = {}) =>
      data(await f.client.callTool({ name, arguments: args }));
    const board = await call('create_board', { name: 'Gallery compatibility' });
    const png = await sharp({
      create: { width: 32, height: 24, channels: 3, background: '#3377cc' },
    })
      .png()
      .toBuffer();
    const asset = await call('import_media', {
      base64: png.toString('base64'),
      name: 'Gallery.png',
    });
    // Seed objects as the UI does: the MCP must accept complete objects it reads back.
    f.store.patchBoard({
      id: board.id,
      revision: 0,
      upserts: [
        {
          id: 'gallery',
          type: 'frame',
          x: 0,
          y: 0,
          width: 680,
          height: 280,
          z: 1,
          text: 'Journey',
          gallery: { direction: 'below', size: 320, gap: 20 },
        },
        {
          id: 'photo',
          type: 'image',
          x: 20,
          y: 20,
          width: 320,
          height: 240,
          z: 2,
          assetId: asset.id,
          galleryId: 'gallery',
          galleryIndex: 0,
          galleryRow: 0,
          galleryColumn: 0,
          imageTitle: 'Original',
        },
      ],
      deleted: [],
    });
    const before = await call('read_board', { id: board.id });
    const frame = before.objects.find((o) => o.id === 'gallery');
    const photo = before.objects.find((o) => o.id === 'photo');
    await call('edit_board', {
      id: board.id,
      revision: before.revision,
      upserts: [
        { ...frame, text: 'Updated journey', gallery: { ...frame.gallery, direction: 'right' } },
        { ...photo, imageTitle: 'Updated original' },
        { ...photo, id: 'photo-copy', x: 360, z: 3, galleryIndex: 1, galleryColumn: 1 },
      ],
    });
    const edited = await call('read_board', { id: board.id });
    assert.equal(edited.objects.length, 3);
    assert.deepEqual(edited.objects.find((o) => o.id === 'gallery').gallery, {
      direction: 'right',
      size: 320,
      gap: 20,
    });
    assert.deepEqual(
      edited.objects.find((o) => o.id === 'photo'),
      { ...photo, imageTitle: 'Updated original' },
    );
    const copy = edited.objects.find((o) => o.id === 'photo-copy');
    assert.equal(copy.assetId, asset.id);
    assert.equal(copy.galleryId, 'gallery');
    assert.equal(copy.galleryRow, 0);
    assert.equal(copy.galleryColumn, 1);
    for (const invalid of [
      { ...frame, gallery: { direction: 'below', size: 0, gap: 20 } },
      { ...photo, galleryRow: 0.5 },
      { ...photo, galleryColumn: 10001 },
      { ...photo, galleryId: 'invalid/id' },
    ]) {
      const result = await f.client.callTool({
        name: 'edit_board',
        arguments: {
          id: board.id,
          revision: edited.revision,
          upserts: [invalid],
        },
      });
      assert.equal(result.isError, true);
    }
    const reopened = new Store(f.root);
    try {
      assert.deepEqual(reopened.loadBoard({ id: board.id }).objects, edited.objects);
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});

test('MCP board settings persist across rename, icons, colors, shape, initial, move, reorder and trash', async () => {
  const f = await fixture();
  try {
    const call = async (name, args = {}) =>
      data(await f.client.callTool({ name, arguments: args }));
    const folder = await call('create_folder', { name: 'Settings folder' });
    const board = await call('create_board', { name: 'Settings board' });
    for (const color of ['blue', 'green', 'purple', 'orange', 'rose', 'gray', 'yellow']) {
      await call('update_board', { id: board.id, patch: { color } });
      assert.equal((await call('read_board', { id: board.id })).board.color, color);
    }
    for (const icon of ['none', 'lightbulb', 'emoji:🌿']) {
      await call('update_board', { id: board.id, patch: { icon } });
      assert.equal((await call('read_board', { id: board.id })).board.icon, icon);
    }
    const patch = {
      name: 'Renamed settings',
      iconShape: 'circle',
      showInitial: false,
      folderId: folder.id,
      position: 2.5,
      trashed: true,
    };
    await call('update_board', { id: board.id, patch });
    const saved = (await call('read_board', { id: board.id })).board;
    for (const [key, value] of Object.entries(patch)) assert.equal(saved[key], value, key);
    await call('update_board', {
      id: board.id,
      patch: {
        iconShape: 'rounded',
        showInitial: true,
        folderId: null,
        trashed: false,
      },
    });
    const restored = (await call('read_board', { id: board.id })).board;
    assert.equal(restored.trashed, false);
    assert.equal(restored.folderId, null);
    assert.equal(restored.iconShape, 'rounded');
    assert.equal(restored.showInitial, true);
    const reopened = new Store(f.root);
    try {
      assert.deepEqual(reopened.loadBoard({ id: board.id }).board, restored);
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});

test('MCP rejects unauthenticated requests, foreign origins/hosts, malformed data, disabled and queued access', async () => {
  const f = await fixture();
  try {
    const url = f.service.status().url;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const headers = {
      Authorization: 'Bearer ' + f.token,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://untrusted.example' },
          body: '{}',
        })
      ).status,
      403,
    );
    const foreignHost = await new Promise((resolve, reject) => {
      const req = httpRequest(
        url,
        { method: 'POST', headers: { ...headers, host: 'untrusted.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(foreignHost, 403);
    assert.equal((await fetch(url, { method: 'POST', headers, body: 'not json' })).status, 400);
    const bad = await f.client.callTool({
      name: 'import_media',
      arguments: { base64: 'not base64', name: 'test.png' },
    });
    assert.equal(bad.isError, true);
    const mismatch = await f.client.callTool({
      name: 'edit_board',
      arguments: { id: 'bad', revision: 0, upserts: [{ id: 'bad' }] },
    });
    assert.equal(mismatch.isError, true);
    let release, entered;
    const entry = new Promise((r) => (entered = r));
    const pause = new Promise((r) => (release = r));
    f.service.transaction = async (job) => {
      entered();
      await pause;
      return job();
    };
    const request = f.client
      .callTool({ name: 'create_board', arguments: { name: 'Must not be created' } })
      .catch(() => null);
    await entry;
    await f.service.update({ enabled: false });
    release();
    await request;
    await f.service.jobs;
    assert.equal(f.store.library().boards.length, 0);
    await assert.rejects(fetch(url));
    assert.equal(f.service.status().running, false);
  } finally {
    await f.close();
  }
});
test('Claude stdio connector discovers tools while disabled and works after enabling without restarting connector', async () => {
  const f = await fixture();
  const client = new Client({ name: 'claude-test', version: '1' });
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('electron/mcp-stdio.cjs')],
      env: { ...process.env, CANVAS_DATA_DIR: f.root },
      stderr: 'pipe',
    });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 15);
    assert.ok(
      data(await client.callTool({ name: 'create_board', arguments: { name: 'From Claude' } })).id,
    );
    await f.service.update({ enabled: false });
    assert.equal((await client.callTool({ name: 'list_boards', arguments: {} })).isError, true);
    await f.service.update({ enabled: true });
    assert.equal(
      data(await client.callTool({ name: 'list_boards', arguments: {} })).boards[0].name,
      'From Claude',
    );
  } finally {
    await client.close();
    await f.close();
  }
});
test('MCP enable state and port survive restart, and occupied ports report a recoverable error', async () => {
  const f = await fixture();
  let other;
  try {
    const config = JSON.parse(readFileSync(settingsFile(f.root), 'utf8'));
    await f.service.stop();
    other = new McpService({ root: f.root, call: (c, a) => f.store[c](a) });
    await other.start();
    assert.equal(other.status().running, true);
    assert.equal(other.status().port, config.port);
    const conflicting = new McpService({ root: f.root, call: (c, a) => f.store[c](a) });
    await conflicting.start();
    assert.equal(conflicting.status().running, false);
    assert.match(conflicting.status().error, /EADDRINUSE/);
    await other.update({ enabled: false });
    const disabled = new McpService({ root: f.root, call: (c, a) => f.store[c](a) });
    await disabled.start();
    assert.equal(disabled.status().running, false);
  } finally {
    await other?.stop();
    await f.close();
  }
});

test('MCP builds HTML embed mockups: create from a file, cheap edits, compact reads and pictures', async () => {
  const captured = [];
  let f;
  const services = {
    captureHtml: async (args) => {
      captured.push(args);
      const bytes = await sharp({
        create: { width: 64, height: 40, channels: 3, background: '#2f6fed' },
      })
        .png()
        .toBuffer();
      return (await f.store.importAsset({ bytes, name: 'HTML embed.png' })).id;
    },
  };
  f = await fixture(services);
  try {
    const call = async (name, args = {}) =>
      data(await f.client.callTool({ name, arguments: args }));
    const board = await call('create_board', { name: 'Mockups' });
    await call('edit_board', {
      id: board.id,
      revision: 0,
      upserts: [
        { id: 'note', type: 'note', x: 0, y: 0, width: 200, height: 200, z: 3, text: 'Hi' },
      ],
    });
    // A page with its stylesheet, script and image next to it.
    const dir = join(f.root, 'mockup');
    mkdirSync(join(dir, 'img'), { recursive: true });
    writeFileSync(join(dir, 'style.css'), 'body{background:url(img/dot.png)} h1{color:#123456}');
    writeFileSync(join(dir, 'app.js'), 'document.title = "ok"; // </script> inside');
    writeFileSync(join(dir, 'img', 'dot.png'), Buffer.from([137, 80, 78, 71]));
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="style.css">' +
        '<script src="https://cdn.example.com/lib.js"></script></head>' +
        '<body><h1>Dashboard</h1><img src="img/dot.png"><script src="app.js"></script></body></html>',
    );
    const created = await f.client.callTool({
      name: 'html_embed',
      arguments: { id: board.id, file: join(dir, 'index.html'), width: 800, height: 500 },
    });
    const made = data(created);
    assert.equal(made.created, true);
    assert.deepEqual([made.x, made.y, made.width, made.height], [280, 0, 800, 500]);
    assert.equal(created.content[1].type, 'image', 'the rendered page comes back as a picture');
    assert.deepEqual(captured.at(-1), {
      html: captured.at(-1).html,
      width: 800,
      height: 500,
    });
    const page = captured.at(-1).html;
    assert.match(page, /<style>\nbody\{background:url\("data:image\/png;base64,/);
    assert.match(page, /<script>\ndocument.title = "ok"; \/\/ <\\\/script> inside\n<\/script>/);
    assert.match(page, /<img src="data:image\/png;base64,iVBORw==">/);
    assert.match(page, /src="https:\/\/cdn.example.com\/lib.js"/, 'web scripts stay links');

    // Board reads stay small: sources are left out.
    const read = await call('read_board', { id: board.id });
    const embed = read.objects.find((o) => o.id === made.embedId);
    assert.equal(embed.html, undefined);
    assert.equal(embed.htmlChars, page.length);
    assert.equal(embed.assetId, made.pictureAssetId);

    // A small edit changes the stored page and captures a new picture.
    const edited = await call('html_embed', {
      id: board.id,
      embedId: made.embedId,
      edits: [{ find: '<h1>Dashboard</h1>', replace: '<h1>Revenue</h1>' }],
      picture: false,
    });
    assert.equal(edited.created, false);
    assert.equal(captured.length, 2);
    const source = await call('read_html_embed', { id: board.id, embedId: made.embedId });
    assert.match(source.source, /^1\t<!doctype html>/);
    assert.match(source.source, /<h1>Revenue<\/h1>/);
    const ambiguous = await f.client.callTool({
      name: 'html_embed',
      arguments: { id: board.id, embedId: made.embedId, edits: [{ find: 'h1', replace: 'h2' }] },
    });
    assert.ok(ambiguous.isError);
    assert.match(ambiguous.content[0].text, /appears \d+ times/);

    // Moving it keeps its picture: same page, same size.
    const moved = await call('html_embed', { id: board.id, embedId: made.embedId, x: 0, y: 400 });
    assert.equal(captured.length, 2);
    assert.equal(moved.pictureAssetId, edited.pictureAssetId);

    // edit_board keeps a source it was not given, from a compact read.
    const compact = (await call('read_board', { id: board.id })).objects.find(
      (o) => o.id === made.embedId,
    );
    const { htmlChars, ...rest } = compact;
    await call('edit_board', {
      id: board.id,
      revision: (await call('read_board', { id: board.id })).revision,
      upserts: [{ ...rest, width: 900 }],
    });
    const stored = f.store.loadBoard({ id: board.id }).objects.find((o) => o.id === made.embedId);
    assert.match(stored.html, /<h1>Revenue<\/h1>/);
    assert.equal(stored.width, 900);
  } finally {
    await f.close();
  }
});

test('MCP reads what the user looks at, places they looked at recently and recent changes', async () => {
  const f = await fixture();
  try {
    const call = async (name, args) => data(await f.client.callTool({ name, arguments: args }));
    const board = await call('create_board', { name: 'Views' });
    const box = (id, x, y) => ({ id, type: 'rect', x, y, width: 100, height: 100, z: 1 });
    await call('edit_board', {
      id: board.id,
      revision: 0,
      upserts: [box('left', 0, 0), box('right', 2000, 0), box('far', 9000, 9000)],
    });
    // No place recorded yet: the whole board, no view.
    const fresh = await call('read_board', { id: board.id, within: 'view' });
    assert.equal(fresh.view, null);
    assert.deepEqual(fresh.recentViews, []);
    assert.equal(fresh.total, 3);

    // The app reports the visible area with each camera save.
    const look = (x, y, width = 1000, height = 600) =>
      f.store.saveCamera({
        id: board.id,
        camera: { x: -x, y: -y, zoom: 1 },
        view: { x, y, width, height },
      });
    look(-50, -50);
    look(0, 0); // a small pan stays the same place
    let read = await call('read_board', { id: board.id, within: 'view' });
    assert.equal(read.recentViews.length, 1);
    assert.deepEqual(
      read.objects.map((o) => o.id),
      ['left'],
    );
    assert.deepEqual(
      { x: read.view.x, y: read.view.y, width: read.view.width },
      { x: 0, y: 0, width: 1000 },
    );
    assert.match(read.view.at, /^\d{4}-\d\d-\d\dT/);

    look(1900, -100); // somewhere else
    read = await call('read_board', { id: board.id, within: 'view' });
    assert.deepEqual(
      read.objects.map((o) => o.id),
      ['right'],
    );
    assert.equal(read.recentViews.length, 2);
    assert.equal(read.recentViews[0].x, 1900);
    // An earlier place, or any area, given as a rectangle.
    const earlier = read.recentViews[1];
    assert.deepEqual(
      (
        await call('read_board', {
          id: board.id,
          within: { x: earlier.x, y: earlier.y, width: earlier.width, height: earlier.height },
        })
      ).objects.map((o) => o.id),
      ['left'],
    );
    assert.equal(
      (
        await call('read_board', {
          id: board.id,
          within: { x: 8000, y: 8000, width: 5000, height: 5000 },
        })
      ).total,
      1,
    );
    // A camera save without a view (older app) changes no places.
    f.store.saveCamera({ id: board.id, camera: { x: 1, y: 1, zoom: 1 } });
    assert.equal((await call('read_board', { id: board.id })).recentViews.length, 2);

    // Recently changed objects, newest first, with who changed them.
    const before = await call('read_board', { id: board.id });
    await call('edit_board', {
      id: board.id,
      revision: before.revision,
      upserts: [{ ...box('far', 9100, 9000) }],
    });
    const changed = await call('read_board', { id: board.id, changedWithinMinutes: 5 });
    assert.equal(changed.total, 3);
    assert.equal(changed.changes[0].id, 'far');
    assert.equal(changed.changes[0].source, 'ai');
    assert.match(changed.changes[0].at, /^\d{4}-/);
    // Combined with the view: only changed objects in it.
    assert.deepEqual(
      (
        await call('read_board', { id: board.id, within: 'view', changedWithinMinutes: 5 })
      ).objects.map((o) => o.id),
      ['right'],
    );
    // Bad views are refused.
    assert.throws(() =>
      f.store.saveCamera({
        id: board.id,
        camera: { x: 0, y: 0, zoom: 1 },
        view: { x: 0, y: 0, width: -1, height: 5 },
      }),
    );
  } finally {
    await f.close();
  }
});
test('MCP clients start the AppImage file itself, and the executable elsewhere', async () => {
  const { stdioLauncher } = require('../electron/mcp-server.cjs');
  const mount = '/tmp/.mount_terraXY';
  const script = `${mount}/resources/app.asar/electron/mcp-stdio.cjs`;
  const appImage = stdioLauncher({
    executable: `${mount}/terra-board`,
    env: { APPIMAGE: '/home/me/Apps/Terra-Board-x86_64.AppImage' },
    platform: 'linux',
    script,
  });
  assert.equal(appImage.command, '/bin/sh');
  assert.equal(appImage.args[0], '-c');
  assert.match(appImage.args[1], /--appimage-mount/);
  assert.deepEqual(appImage.args.slice(2), [
    'terra-board-mcp',
    '/home/me/Apps/Terra-Board-x86_64.AppImage',
    'terra-board',
    'resources/app.asar/electron/mcp-stdio.cjs',
  ]);
  assert.doesNotMatch(appImage.args.join(' '), /\.mount_/);
  const deb = stdioLauncher({
    executable: '/opt/Terra Board/terra-board',
    env: {},
    platform: 'linux',
    script: '/opt/Terra Board/resources/app.asar/electron/mcp-stdio.cjs',
  });
  assert.deepEqual(deb, {
    command: '/opt/Terra Board/terra-board',
    args: ['/opt/Terra Board/resources/app.asar/electron/mcp-stdio.cjs'],
  });
  const windows = stdioLauncher({
    executable: 'C:\Terra\Terra Board.exe',
    env: { APPIMAGE: 'ignored' },
    platform: 'win32',
    script: 'C:\Terra\resources\app.asar\electron\mcp-stdio.cjs',
  });
  assert.equal(windows.command, 'C:\Terra\Terra Board.exe');
});
