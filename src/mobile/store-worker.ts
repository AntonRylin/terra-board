/// <reference lib="webworker" />
// The Android library: electron/store.cjs, unchanged, on SQLite-WASM in this
// worker. Mirrors electron/worker.cjs: commands run one at a time in order,
// asset reads run beside them.
import { Buffer } from 'buffer';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { setDatabaseOpener } from './shims/sqlite.ts';
import { setFileDatabase, readFileSync } from './shims/fs.ts';
import { waitForFreePool } from './pool-guard.ts';
import { startCloud } from './cloud-worker.ts';

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

// Writes that change synced content; cloud sync pushes shortly after them (main.cjs).
const synced = new Set([
  'createBoard',
  'createFolder',
  'updateBoard',
  'updateFolder',
  'removeFolder',
  'restoreBoard',
  'duplicateBoard',
  'patchBoard',
  'importBoard',
]);

type Message = { id: number; command: string; args?: any };
const reply = (id: number, result: unknown, transfer: Transferable[] = []) =>
  scope.postMessage({ id, result }, transfer);
const fail = (id: number, e: unknown) =>
  scope.postMessage({ id, error: e instanceof Error ? e.message : String(e) });

// One storage worker at a time owns the library. The lock is released when
// this worker ends, so a reloaded page's worker waits for the old one.
function holdLibrary(timeout = 15000) {
  return new Promise<void>((resolve, reject) => {
    navigator.locks
      .request('terra-board-library', { signal: AbortSignal.timeout(timeout) }, () => {
        resolve();
        return new Promise(() => {});
      })
      .catch(() =>
        reject(
          Error(
            'the library is still open somewhere else (another tab or window of Terra Board). Close it and reload this page.',
          ),
        ),
      );
  });
}

// Signing out deletes the library (wipe below). This file, outside the pool,
// says a wipe has started, so one cut short (the app killed meanwhile)
// finishes at the next start instead of leaving the last account's boards.
const WIPE_MARKER = 'terra-board-wipe';
const opfs = () => navigator.storage.getDirectory();
async function wipePending() {
  try {
    await (await opfs()).getFileHandle(WIPE_MARKER);
    return true;
  } catch {
    return false;
  }
}

let pool: any = null;
let files: any = null;
const ready = (async () => {
  const sqlite3 = await sqlite3InitModule();
  await holdLibrary();
  // installOpfsSAHPoolVfs deletes the whole pool if it cannot open a file.
  await waitForFreePool('/terra-board');
  pool = await sqlite3.installOpfsSAHPoolVfs({
    name: 'terra-pool',
    directory: '/terra-board',
    initialCapacity: 16,
  });
  if (await wipePending()) {
    await pool.wipeFiles();
    await (await opfs()).removeEntry(WIPE_MARKER);
  }
  await pool.reserveMinimumCapacity(16);
  files = new pool.OpfsSAHPoolDb('/files.sqlite');
  setFileDatabase(files);
  setDatabaseOpener((file) => new pool.OpfsSAHPoolDb(file));
  const { Store } = await import('../../electron/store.cjs');
  // No starter board: the library is the person's cloud library (docs/android.md).
  return new Store(root);
})();
ready.catch(() => {});

// Commands run one at a time, in order: the page's and cloud sync's alike.
let chain: Promise<unknown> = Promise.resolve();
function queue<T>(job: () => T | Promise<T>): Promise<T> {
  const result = chain.then(job);
  chain = result.catch(() => {});
  return result;
}

// Signing out: everything on this phone goes, then the page reloads into the
// sign-in screen with an empty library.
async function wipe() {
  const store = await ready;
  await queue(async () => {
    await (await opfs()).getFileHandle(WIPE_MARKER, { create: true });
    try {
      store.close();
      files?.close();
      // Every file of the pool: the boards, pictures, settings and the session.
      await pool.wipeFiles();
      await (await opfs()).removeEntry(WIPE_MARKER);
    } finally {
      // Nothing may touch the closed databases until the page reloads; a wipe
      // that failed here runs again at the next start (the marker stays).
      chain = new Promise(() => {});
      scope.postMessage({ type: 'wiped' });
    }
  });
}

const cloud = ready.then((store) =>
  startCloud({ store, queue, post: (m) => scope.postMessage(m), root, wipe }),
);
cloud.catch(() => {});

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
  // Cloud calls queue their own store commands, so they run beside the queue.
  if (command === 'cloud') {
    try {
      reply(id, await (await cloud).run(args?.method, args?.params || []));
    } catch (e) {
      fail(id, e);
    }
    return;
  }
  if (command === 'externalReady') {
    (await cloud).pageReady(args?.id, args?.error);
    return reply(id, true);
  }
  queue(async () => {
    try {
      if (command === 'ping') return reply(id, true);
      if (!allowed.has(command)) throw Error('Unknown command');
      const result = await (store as any)[command](args);
      if (synced.has(command)) void cloud.then((c) => c.localChanged());
      if (result instanceof Uint8Array) {
        const copy = new Uint8Array(result);
        reply(id, copy, [copy.buffer]);
      } else reply(id, result);
    } catch (e) {
      fail(id, e);
    }
  });
};
