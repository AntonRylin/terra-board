// node:sqlite's DatabaseSync, as electron/store.cjs uses it, on SQLite-WASM.
// Only the parts the store and its sync code call: exec, prepare (run, get,
// all, iterate with positional parameters), function and close.
import type { Database, PreparedStatement, SqlValue } from '@sqlite.org/sqlite-wasm';

type Opener = (file: string) => Database;
let opener: Opener | null = null;
// Set by the storage worker once the OPFS pool is ready.
export function setDatabaseOpener(open: Opener) {
  opener = open;
}

const value = (v: unknown): SqlValue => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v as SqlValue;
};

class StatementSync {
  private db: Database;
  private sql: string;
  constructor(db: Database, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  private statement(params: unknown[]) {
    const s = this.db.prepare(this.sql);
    if (params.length) s.bind(params.map(value));
    return s;
  }
  private rows(s: PreparedStatement, limit = Infinity) {
    const out: Record<string, SqlValue>[] = [];
    while (out.length < limit && s.step()) out.push(s.get({}) as Record<string, SqlValue>);
    return out;
  }
  run(...params: unknown[]) {
    const s = this.statement(params);
    try {
      while (s.step());
    } finally {
      s.finalize();
    }
    return {
      changes: this.db.changes(),
      lastInsertRowid: Number(this.db.selectValue('SELECT last_insert_rowid()')),
    };
  }
  get(...params: unknown[]) {
    const s = this.statement(params);
    try {
      return this.rows(s, 1)[0];
    } finally {
      s.finalize();
    }
  }
  all(...params: unknown[]) {
    const s = this.statement(params);
    try {
      return this.rows(s);
    } finally {
      s.finalize();
    }
  }
  // Reads every row first: callers may write between iterations, which an
  // open statement would not allow on every VFS.
  *iterate(...params: unknown[]) {
    yield* this.all(...params);
  }
}

export class DatabaseSync {
  private db: Database | null;
  constructor(file: string) {
    if (!opener) throw Error('Storage is not ready');
    this.db = opener(file);
  }
  private open() {
    if (!this.db) throw Error('Database is closed');
    return this.db;
  }
  exec(sql: string) {
    // The pool VFS has no shared memory: WAL is unavailable and SQLite keeps
    // its rollback journal. A daily VACUUM INTO backup would double the
    // library's size on the phone every day; Android backs up the app instead.
    if (/^\s*VACUUM\s+INTO\b/i.test(sql)) return;
    this.open().exec(sql.replace(/PRAGMA journal_mode=WAL;/i, ''));
  }
  prepare(sql: string) {
    return new StatementSync(this.open(), sql);
  }
  function(
    name: string,
    options: { deterministic?: boolean } | ((...args: unknown[]) => unknown),
    fn?: (...args: unknown[]) => unknown,
  ) {
    const call = (typeof options === 'function' ? options : fn)!;
    this.open().createFunction({
      name,
      // SQLite-WASM counts arguments from xFunc, which takes them as a rest list.
      arity: call.length,
      deterministic: typeof options === 'object' && !!options.deterministic,
      xFunc: (_ctx: number, ...args: SqlValue[]) => value(call(...args)),
    });
  }
  close() {
    this.db?.close();
    this.db = null;
  }
}
