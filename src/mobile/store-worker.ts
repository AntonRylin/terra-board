/// <reference lib="webworker" />
// The Android library: electron/store.cjs, unchanged, on SQLite-WASM in this
// worker. Mirrors electron/worker.cjs: commands run one at a time in order,
// asset reads run beside them.
import { Buffer } from 'buffer';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { setDatabaseOpener } from './shims/sqlite.ts';
import { setFileDatabase, readFileSync } from './shims/fs.ts';

(globalThis as any).Buffer ??= Buffer;
const scope = self as unknown as DedicatedWorkerGlobalScope;
const root = '/library';
const allowed = new Set([
  'library',
  'createBoard',
  'createFolder',
  'updateBoard',
  'updateFolder',
  'removeFolder',
  'restoreBoard',
  'duplicateBoard',
  'loadBoard',
  'searchContent',
  'boardHistory',
  'boardViews',
  'changedObjects',
  'patchBoard',
  'saveCamera',
  'setLastBoard',
  'importAsset',
  'assetLinks',
  'assetInfo',
  'boardSyncs',
  'boardInfo',
  'exportBoard',
  'importBoard',
]);

type Message = { id: number; command: string; args?: any };
const reply = (id: number, result: unknown, transfer: Transferable[] = []) =>
  scope.postMessage({ id, result }, transfer);
const fail = (id: number, e: unknown) =>
  scope.postMessage({ id, error: e instanceof Error ? e.message : String(e) });

const ready = (async () => {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: 'terra-pool',
    directory: '/terra-board',
    initialCapacity: 16,
  });
  await pool.reserveMinimumCapacity(16);
  setFileDatabase(new pool.OpfsSAHPoolDb('/files.sqlite'));
  setDatabaseOpener((file) => new pool.OpfsSAHPoolDb(file));
  const { Store } = await import('../../electron/store.cjs');
  const store = new Store(root);
  if (!store.library().boards.length) store.createBoard({ name: 'Ideas' });
  return store;
})();
ready.catch(() => {});

let chain: Promise<unknown> = Promise.resolve();
scope.onmessage = async ({ data }: MessageEvent<Message>) => {
  const { id, command, args } = data;
  let store;
  try {
    store = await ready;
  } catch (e) {
    return fail(
      id,
      Error(
        'Terra Board could not open its storage on this device: ' +
          (e instanceof Error ? e.message : String(e)),
      ),
    );
  }
  // Media reads do not wait behind saves (electron/worker.cjs does the same).
  if (command === 'asset') {
    try {
      const a = await store.readAsset(args);
      const bytes = new Uint8Array(readFileSync(a.file) as Uint8Array);
      reply(id, { contentType: a.contentType, bytes }, [bytes.buffer]);
    } catch (e) {
      fail(id, e);
    }
    return;
  }
  chain = chain.then(async () => {
    try {
      if (command === 'ping') return reply(id, true);
      if (!allowed.has(command)) throw Error('Unknown command');
      const result = await (store as any)[command](args);
      if (result instanceof Uint8Array) {
        const copy = new Uint8Array(result);
        reply(id, copy, [copy.buffer]);
      } else reply(id, result);
    } catch (e) {
      fail(id, e);
    }
  });
};
