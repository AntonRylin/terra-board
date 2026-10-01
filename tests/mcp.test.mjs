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
async function fixture() {
  mkdirSync(resolve('.local-test'), { recursive: true });
  const root = mkdtempSync(resolve('.local-test/mcp-'));
  const store = new Store(root);
  const service = new McpService({
    root,
    call: (c, a) => (c === 'asset' ? store.readAsset(a) : store[c](a)),
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
    assert.equal(names.length, 11);
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
    const config = JSON.parse(readFileSync(settingsFile(f.root), 'utf8'));
    assert.equal(config.enabled, true);
    const reopened = new Store(f.root);
    assert.equal(reopened.loadBoard({ id: board.id }).objects[0].assetId, asset.id);
    reopened.close();
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
    assert.equal((await client.listTools()).tools.length, 11);
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
