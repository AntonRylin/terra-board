import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

test(
  'worker validates commands, imports native paths, exports files and reopens after termination',
  { timeout: 15000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'canvas-worker-'));
    let worker,
      counter = 0;
    const start = () => {
      worker = new Worker(new URL('../electron/worker.cjs', import.meta.url), {
        workerData: { root },
      });
    };
    const call = (command, args = {}) =>
      new Promise((resolve, reject) => {
        const id = ++counter;
        const message = (m) => {
          if (m.id !== id) return;
          cleanup();
          m.error ? reject(Error(m.error)) : resolve(m.result);
        };
        const error = (e) => {
          cleanup();
          reject(e);
        };
        const cleanup = () => {
          worker.off('message', message);
          worker.off('error', error);
        };
        worker.on('message', message);
        worker.on('error', error);
        worker.postMessage({ id, command, args });
      });
    try {
      start();
      await assert.rejects(call('exec', { sql: 'DROP TABLE boards' }), /Unknown command/);
      const board = await call('createBoard', { name: 'Native workflow' });
      const file = join(root, 'Материал.png');
      writeFileSync(
        file,
        await sharp({ create: { width: 32, height: 24, channels: 3, background: '#567890' } })
          .png()
          .toBuffer(),
      );
      const asset = await call('importFile', { file });
      await call('patchBoard', {
        id: board.id,
        revision: 0,
        operationId: 'native-save',
        upserts: [
          {
            id: 'image',
            type: 'image',
            assetId: asset.id,
            x: 1,
            y: 2,
            width: 32,
            height: 24,
            z: 1,
          },
        ],
        deleted: [],
      });
      const exported = join(root, 'Saved.canvas');
      assert.equal(await call('exportFile', { id: board.id, file: exported }), true);
      assert.ok(readFileSync(exported).byteLength > 100);
      const imported = await call('importFile', { file: exported });
      assert.notEqual(imported.id, board.id);
      await worker.terminate();
      start();
      const reopened = await call('loadBoard', { id: imported.id });
      assert.equal(reopened.objects[0].assetId, asset.id);
      await call('close');
    } finally {
      if (worker) await worker.terminate();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
