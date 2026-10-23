// Files a synced board uses but that failed to download are remembered and fetched again
// (store-sync fetchFailed / fetchDue / fetchDone / scanMissing, CloudSync.retryFetches).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Store } = require('../electron/store.cjs');
const { CloudSync } = require('../electron/cloud-sync.cjs');
const sharp = require('sharp');

const workspace = '6f1c7a52-3f2d-4d55-9a3e-0d6b8c1e2f40';
const boardId = 'b-shared';

// A library whose synced board shows a picture it never received.
async function withMissingPicture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'terra-fetch-test-'));
  const store = new Store(root);
  try {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#2a9d8f' },
    })
      .png()
      .toBuffer();
    const assetId = createHash('sha256').update(png).digest('hex');
    store.syncEnable({ workspace });
    store.syncApply({
      workspace,
      cursor: 2,
      rows: [
        { kind: 'board', board_id: '', id: boardId, data: { name: 'Slides' }, seq: 1 },
        {
          kind: 'object',
          board_id: boardId,
          id: 'img',
          data: { id: 'img', type: 'image', x: 0, y: 0, width: 8, height: 8, z: 1, assetId },
          seq: 2,
        },
      ],
    });
    assert.deepEqual(store.syncMissingAssets({ ids: [assetId] }), [assetId]);
    await fn({ store, png, assetId });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('a missing picture is found at start and tried again with growing pauses', () =>
  withMissingPicture(async ({ store, png, assetId }) => {
    assert.deepEqual(store.syncScanMissing(), { queued: 1 });
    assert.deepEqual(store.syncScanMissing(), { queued: 0 }, 'queued once');
    assert.deepEqual(
      store.syncFetchDue({ now: 0 }).map((r) => ({ ...r })),
      [{ workspace, id: assetId, boardId }],
    );

    const now = 1_000_000;
    store.syncFetchFailed({ workspace, items: [{ id: assetId, boardId }], now });
    assert.equal(store.syncFetchDue({ now: now + 29_000 }).length, 0, 'waits 30 s');
    store.syncFetchFailed({ workspace, items: [{ id: assetId, boardId }], now });
    assert.equal(store.syncFetchDue({ now: now + 59_000 }).length, 0, 'then 60 s');
    assert.equal(store.syncFetchDue({ now: now + 61_000 }).length, 1);
    for (let i = 0; i < 30; i++)
      store.syncFetchFailed({ workspace, items: [{ id: assetId, boardId }], now });
    assert.equal(store.syncFetchDue({ now: now + 6 * 3600_000 - 1000 }).length, 0);
    assert.equal(store.syncFetchDue({ now: now + 6 * 3600_000 }).length, 1, 'at most 6 h');

    const imported = await store.syncImportAsset({ bytes: png, name: 'slide.png', workspace });
    assert.equal(imported.id, assetId);
    assert.deepEqual(store.syncFetchDone({ ids: [assetId] }), [boardId]);
    assert.equal(store.syncFetchDue({ now: Infinity }).length, 0);
  }));

test('files no synced board shows any more are forgotten; sync off clears the list', () =>
  withMissingPicture(async ({ store, assetId }) => {
    store.syncFetchFailed({ workspace, items: [{ id: assetId, boardId: 'gone' }], now: 0 });
    assert.deepEqual(store.syncFetchDue({ now: Infinity }), []);
    store.syncScanMissing();
    store.syncDisable();
    store.syncEnable({ workspace });
    assert.deepEqual(store.syncFetchDue({ now: Infinity }), []);
  }));

// The parts of supabase-js retryFetches uses.
function fakeClient(download) {
  const query = {
    select: () => query,
    eq: () => query,
    in: async () => ({ data: [{ id: 'x', data: { name: 'slide.png' } }], error: null }),
  };
  return {
    from: () => query,
    storage: { from: () => ({ download }) },
  };
}

test('CloudSync fetches remembered files again and reloads the board that shows them', () =>
  withMissingPicture(async ({ store, png, assetId }) => {
    const reloaded = [];
    const sync = new CloudSync({
      call: async (command, args) => store[command](args),
      root: mkdtempSync(join(tmpdir(), 'terra-fetch-root-')),
      config: null,
      transaction: async (job) => reloaded.push(await job()),
    });
    store.syncScanMissing();
    const answers = [
      // Like supabase-js: errors are Error objects.
      { data: null, error: Object.assign(Error('Object not found'), { statusCode: '404' }) },
      { data: null, error: Error('TypeError: Failed to fetch') },
      { data: new Blob([png]), error: null },
    ];
    const asked = [];
    sync.client = fakeClient(async (path) => (asked.push(path), answers.shift()));

    await sync.retryFetches();
    assert.deepEqual(asked, [`${workspace}/${assetId}`]);
    assert.equal(store.syncFetchDue({ now: Date.now() }).length, 0, 'refused: waits');
    assert.deepEqual(reloaded, []);

    store.db.exec('UPDATE sync_fetch SET due=0');
    await assert.rejects(sync.retryFetches(), /Failed to fetch/, 'offline stops the round');
    assert.equal(store.db.prepare('SELECT tries FROM sync_fetch').get().tries, 1, 'not counted');

    await sync.retryFetches();
    assert.deepEqual(store.syncMissingAssets({ ids: [assetId] }), []);
    assert.deepEqual(reloaded, [{ library: false, boards: [boardId] }]);
    assert.deepEqual(store.syncFetchDue({ now: Infinity }), []);
  }));
