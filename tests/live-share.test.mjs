import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const { LiveShare } = require('../electron/live-share.cjs');
const sharp = require('sharp');

const note = (id, text) => ({ id, type: 'note', x: 0, y: 0, width: 200, height: 160, text, z: 1 });

async function hosting(fn, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'terra-live-'));
  const dist = mkdtempSync(join(tmpdir(), 'terra-live-dist-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Terra Board</title>');
  const store = new Store(root);
  const guestEdits = [];
  const statuses = [];
  const live = new LiveShare({
    call: async (command, args) => store[command](args),
    distDir: dist,
    onStatus: (s) => statuses.push(s),
    onGuestEdit: (id) => guestEdits.push(id),
  });
  const shared = store.createBoard({ name: 'Shared' });
  const other = store.createBoard({ name: 'Private' });
  store.patchBoard({ id: shared.id, revision: 0, upserts: [note('n1', 'hello')] });
  await live.start({ boardId: shared.id, port: 0, ...options });
  const base = `http://127.0.0.1:${live.status().port}`;
  const api = async (path, { body, cookie, origin, method } = {}) => {
    const response = await fetch(base + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: response.status, data, text, headers: response.headers };
  };
  const enter = async (name = 'Anna', allow = 'view') => {
    const asked = await api('/__guest/join', { body: { key: live.session.key, name } });
    assert.equal(asked.status, 200);
    if (allow) {
      const pending = live.status().requests.find((r) => r.id === asked.data.id);
      if (pending) live.answer(pending.id, true, allow);
    }
    const result = await api('/__guest/join/' + asked.data.id);
    const cookie = result.headers.get('set-cookie')?.split(';')[0];
    return { id: asked.data.id, result, cookie };
  };
  try {
    await fn({ store, live, shared, other, api, enter, guestEdits, statuses });
  } finally {
    await live.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dist, { recursive: true, force: true });
  }
}

test('a link without the right key cannot even ask to join', () =>
  hosting(async ({ api }) => {
    const r = await api('/__guest/join', { body: { key: 'guess', name: 'Mallory' } });
    assert.equal(r.status, 403);
  }));

test('guests wait for approval and denied guests get nothing', () =>
  hosting(async ({ api, live }) => {
    const asked = await api('/__guest/join', {
      body: { key: live.session.key, name: 'Ben' },
    });
    assert.equal((await api('/__guest/join/' + asked.data.id)).data.status, 'pending');
    assert.deepEqual(
      live.status().requests.map((r) => r.name),
      ['Ben'],
    );
    live.answer(asked.data.id, false);
    const after = await api('/__guest/join/' + asked.data.id);
    assert.equal(after.data.status, 'denied');
    assert.equal(after.headers.get('set-cookie'), null);
    assert.equal((await api('/__local', { body: { command: 'library' } })).status, 401);
  }));

test('viewers read only the shared board; editors can change it', () =>
  hosting(async ({ api, enter, live, shared, other, store, guestEdits }) => {
    const { result, cookie } = await enter('Anna', 'view');
    assert.equal(result.data.status, 'approved');
    assert.ok(cookie?.startsWith('terra_live='));
    const me = await api('/__guest/me', { cookie });
    assert.equal(me.data.permission, 'view');
    const loaded = await api('/__local', {
      cookie,
      body: { command: 'loadBoard', args: { id: shared.id } },
    });
    assert.equal(loaded.data.result.objects[0].text, 'hello');
    const elsewhere = await api('/__local', {
      cookie,
      body: { command: 'loadBoard', args: { id: other.id } },
    });
    assert.match(elsewhere.data.error, /Only the shared board/);
    const library = await api('/__local', { cookie, body: { command: 'library' } });
    assert.deepEqual(
      library.data.result.boards.map((b) => b.name),
      ['Shared'],
    );
    const patch = {
      command: 'patchBoard',
      args: {
        id: shared.id,
        revision: loaded.data.result.revision,
        upserts: [note('n1', 'changed')],
      },
    };
    assert.match((await api('/__local', { cookie, body: patch })).data.error, /view this board/);
    assert.equal(store.loadBoard({ id: shared.id }).objects[0].text, 'hello');

    const guest = live.status().guests[0];
    live.setGuestPermission(guest.id, 'edit');
    const saved = await api('/__local', { cookie, body: patch });
    assert.ok(saved.data.result.revision > loaded.data.result.revision);
    assert.equal(store.loadBoard({ id: shared.id }).objects[0].text, 'changed');
    assert.deepEqual(guestEdits, [shared.id]);
    const sneaky = await api('/__local', {
      cookie,
      body: { command: 'updateBoard', args: { id: other.id, patch: { name: 'x' } } },
    });
    assert.match(sneaky.data.error, /not available/);
  }));

test('media is limited to what the shared board shows', () =>
  hosting(async ({ api, enter, store, shared, other }) => {
    const png = (color) =>
      sharp({ create: { width: 4, height: 4, channels: 3, background: color } })
        .png()
        .toBuffer();
    const visible = await store.importAsset({ bytes: await png('#ff0000'), name: 'a.png' });
    const hidden = await store.importAsset({ bytes: await png('#00ff00'), name: 'b.png' });
    const rev = store.loadBoard({ id: shared.id }).revision;
    store.patchBoard({
      id: shared.id,
      revision: rev,
      upserts: [
        { id: 'img', type: 'image', x: 0, y: 0, width: 4, height: 4, z: 2, assetId: visible.id },
      ],
    });
    store.patchBoard({
      id: other.id,
      revision: 0,
      upserts: [
        { id: 'img', type: 'image', x: 0, y: 0, width: 4, height: 4, z: 2, assetId: hidden.id },
      ],
    });
    const { cookie } = await enter();
    assert.equal((await api(`/__local/asset/${visible.id}/preview`, { cookie })).status, 200);
    assert.equal((await api(`/__local/asset/${hidden.id}/preview`, { cookie })).status, 404);
    assert.equal((await api(`/__local/asset/${visible.id}/preview`)).status, 401);
  }));

test('files outside the app folder and other sites are refused', () =>
  hosting(async ({ api, enter, shared }) => {
    assert.equal((await api('/live')).status, 200);
    assert.equal((await api('/..%2f..%2fpackage.json')).status, 404);
    assert.equal((await api('/%2e%2e/%2e%2e/Windows/win.ini')).status, 404);
    const { cookie } = await enter('Anna', 'edit');
    const forged = await api('/__local', {
      cookie,
      origin: 'http://evil.example',
      body: { command: 'loadBoard', args: { id: shared.id } },
    });
    assert.equal(forged.status, 400);
    assert.match(forged.data.error, /Origin rejected/);
  }));

test('removed guests and stopped sessions lose access', () =>
  hosting(async ({ api, enter, live }) => {
    const { cookie } = await enter();
    live.removeGuest(live.status().guests[0].id);
    assert.equal((await api('/__guest/me', { cookie })).status, 401);
  }));

test('without "ask first" guests are let in straight away', () =>
  hosting(
    async ({ enter }) => {
      const { result, cookie } = await enter('Cara', null);
      assert.equal(result.data.status, 'approved');
      assert.ok(cookie);
    },
    { ask: false, permission: 'edit' },
  ));
