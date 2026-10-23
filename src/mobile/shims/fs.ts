// The synchronous parts of node:fs that electron/store.cjs and its helpers
// use, kept in a SQLite database (files.sqlite) on the same OPFS pool as the
// library. OPFS itself only opens files asynchronously; the store writes asset
// files in the middle of synchronous code.
import type { Database } from '@sqlite.org/sqlite-wasm';
import { Buffer } from 'buffer';
import { posix as path } from './path.ts';

let db: Database | null = null;
export function setFileDatabase(database: Database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,data BLOB NOT NULL,mtime REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS dirs(path TEXT PRIMARY KEY);`);
}
const files = () => {
  if (!db) throw Error('Storage is not ready');
  return db;
};
const norm = (p: unknown) => path.resolve(String(p));
const error = (code: string, syscall: string, p: string) =>
  Object.assign(Error(`${code}: ${syscall} '${p}'`), { code, syscall, path: p });
const bytes = (data: unknown): Uint8Array =>
  typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data instanceof Uint8Array
      ? data
      : new Uint8Array(data as ArrayBuffer);
const like = (dir: string) => (dir === '/' ? '/' : dir + '/').replace(/[\\%_]/g, '\\$&') + '%';

function fileRow(p: string) {
  return files().selectObject('SELECT length(data) AS size,mtime FROM files WHERE path=?', [p]) as
    { size: number; mtime: number } | undefined;
}
function isDir(p: string) {
  return (
    p === '/' ||
    files().selectValue('SELECT 1 FROM dirs WHERE path=?', [p]) === 1 ||
    files().selectValue("SELECT 1 FROM files WHERE path LIKE ? ESCAPE '\\' LIMIT 1", [like(p)]) ===
      1
  );
}
function put(p: string, data: Uint8Array) {
  files().exec({
    sql: 'INSERT INTO files VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data,mtime=excluded.mtime',
    bind: [p, data, Date.now()],
  });
}

export function existsSync(p: unknown) {
  const file = norm(p);
  return !!fileRow(file) || isDir(file);
}
export function mkdirSync(p: unknown, options?: { recursive?: boolean }) {
  let dir = norm(p);
  const made: string[] = [];
  while (dir !== '/' && !isDir(dir)) {
    made.push(dir);
    if (!options?.recursive) break;
    dir = path.dirname(dir);
  }
  for (const d of made) files().exec({ sql: 'INSERT OR IGNORE INTO dirs VALUES(?)', bind: [d] });
}
export function readFileSync(p: unknown, options?: string | { encoding?: string }) {
  const file = norm(p);
  const data = files().selectValue('SELECT data FROM files WHERE path=?', [file]);
  if (!(data instanceof Uint8Array)) throw error('ENOENT', 'open', file);
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ? new TextDecoder().decode(data) : Buffer.from(data);
}

// File descriptors buffer their writes until closed; durableWrite in
// store.cjs opens, writes, syncs, closes and then renames into place.
const open = new Map<number, { path: string; chunks: Uint8Array[] }>();
let nextFd = 100;
export function openSync(p: unknown, flags = 'r') {
  const file = norm(p);
  if (flags.includes('x') && existsSync(file)) throw error('EEXIST', 'open', file);
  const fd = nextFd++;
  open.set(fd, { path: file, chunks: [] });
  return fd;
}
export function writeFileSync(target: unknown, data: unknown) {
  if (typeof target === 'number') {
    const f = open.get(target);
    if (!f) throw error('EBADF', 'write', String(target));
    f.chunks.push(bytes(data));
    return;
  }
  put(norm(target), bytes(data));
}
export function fsyncSync(fd: number) {
  if (!open.has(fd)) throw error('EBADF', 'fsync', String(fd));
}
export function closeSync(fd: number) {
  const f = open.get(fd);
  if (!f) throw error('EBADF', 'close', String(fd));
  open.delete(fd);
  put(f.path, f.chunks.length === 1 ? f.chunks[0] : Buffer.concat(f.chunks));
}
export function renameSync(from: unknown, to: unknown) {
  const a = norm(from),
    b = norm(to);
  if (!fileRow(a)) throw error('ENOENT', 'rename', a);
  files().exec('BEGIN');
  try {
    files().exec({ sql: 'DELETE FROM files WHERE path=?', bind: [b] });
    files().exec({ sql: 'UPDATE files SET path=? WHERE path=?', bind: [b, a] });
    files().exec('COMMIT');
  } catch (e) {
    files().exec('ROLLBACK');
    throw e;
  }
}
export function rmSync(p: unknown, options?: { recursive?: boolean; force?: boolean }) {
  const file = norm(p);
  if (fileRow(file)) {
    files().exec({ sql: 'DELETE FROM files WHERE path=?', bind: [file] });
    return;
  }
  if (isDir(file)) {
    if (!options?.recursive) throw error('EISDIR', 'rm', file);
    files().exec({ sql: "DELETE FROM files WHERE path LIKE ? ESCAPE '\\'", bind: [like(file)] });
    files().exec({
      sql: "DELETE FROM dirs WHERE path=? OR path LIKE ? ESCAPE '\\'",
      bind: [file, like(file)],
    });
    return;
  }
  if (!options?.force) throw error('ENOENT', 'rm', file);
}
export function statSync(p: unknown, options?: { throwIfNoEntry?: boolean }) {
  const file = norm(p);
  const row = fileRow(file);
  const dir = !row && isDir(file);
  if (!row && !dir) {
    if (options?.throwIfNoEntry === false) return undefined;
    throw error('ENOENT', 'stat', file);
  }
  return {
    size: row?.size ?? 0,
    mtimeMs: row?.mtime ?? 0,
    isFile: () => !!row,
    isDirectory: () => dir,
  };
}
export function readdirSync(p: unknown) {
  const dir = norm(p);
  if (!isDir(dir)) throw error('ENOENT', 'scandir', dir);
  const names = new Set<string>();
  const prefix = dir === '/' ? '/' : dir + '/';
  for (const table of ['files', 'dirs'])
    for (const row of files().selectValues(
      `SELECT path FROM ${table} WHERE path LIKE ? ESCAPE '\\'`,
      [like(dir)],
    ))
      names.add(String(row).slice(prefix.length).split('/')[0]);
  return [...names].sort();
}
export const constants = { COPYFILE_EXCL: 1 };
export const promises = {
  copyFile: async (from: unknown, to: unknown, mode = 0) => {
    if (mode & constants.COPYFILE_EXCL && existsSync(to))
      throw error('EEXIST', 'copyfile', norm(to));
    writeFileSync(to, readFileSync(from));
  },
  rename: async (from: unknown, to: unknown) => renameSync(from, to),
  rm: async (p: unknown, options?: { recursive?: boolean; force?: boolean }) => rmSync(p, options),
  readFile: async (p: unknown, options?: string | { encoding?: string }) =>
    readFileSync(p, options),
  writeFile: async (p: unknown, data: unknown) => writeFileSync(p, data),
};
export function createReadStream(): never {
  throw Error('Streams are not available on Android');
}
export default {
  existsSync,
  mkdirSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
  statSync,
  readdirSync,
  constants,
  promises,
  createReadStream,
};
