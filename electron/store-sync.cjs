const path = require('node:path');

// Local half of cloud sync.
//
// A library has at most one personal cloud workspace (its "identity"). Boards
// are tracked when the whole library syncs, when this person shares them (or
// their folder), or when someone else shared them here ("foreign" boards, which
// belong to the sharer's workspace). Triggers record changes to tracked boards
// in an outbox; the sync loop takes, pushes and acknowledges those entries.
// Remote rows are applied under the `applying` flag so they never echo back.
// Boards taken out of the cloud ("local" boards) are never tracked again until
// they are shared anew.
const notApplying = `NOT EXISTS (SELECT 1 FROM sync_state WHERE key='applying')`;
const libraryOn = `EXISTS (SELECT 1 FROM sync_state WHERE key='library')`;
const ownTracked = (id) =>
  `EXISTS (SELECT 1 FROM sync_tracked t WHERE t.id=${id} AND t.foreign_ws IS NULL)`;
const editable = (id) =>
  `EXISTS (SELECT 1 FROM sync_tracked t WHERE t.id=${id} AND (t.role IS NULL OR t.role='edit'))`;
const ownedFolder = (id) => `${id} IN (SELECT targetId FROM sync_owned WHERE kind='folder')`;
const foreignFolder = (id) => `${id} IN (SELECT id FROM sync_foreign WHERE kind='folder')`;
const enqueue = (kind, boardId, id) =>
  `INSERT INTO sync_outbox VALUES('${kind}', ${boardId}, ${id},
    (SELECT coalesce(max(queued), 0) + 1 FROM sync_outbox))
  ON CONFLICT(kind, boardId, id) DO UPDATE SET queued = excluded.queued;`;
const boardColumns =
  'name,icon,color,iconShape,showInitial,backgroundAssetId,backgroundAppearance,folderId,position,trashed';
const triggerNames = [
  'sync_object_insert',
  'sync_object_update',
  'sync_object_delete',
  'sync_board_insert',
  'sync_board_update',
  'sync_board_moved',
  'sync_folder_insert',
  'sync_folder_update',
  'sync_folder_delete',
];

const schema = `
CREATE TABLE IF NOT EXISTS sync_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_outbox(kind TEXT NOT NULL, boardId TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL, queued INTEGER NOT NULL, PRIMARY KEY(kind, boardId, id));
CREATE INDEX IF NOT EXISTS sync_outbox_queued ON sync_outbox(queued);
CREATE TABLE IF NOT EXISTS sync_owned(kind TEXT NOT NULL, targetId TEXT NOT NULL,
  shareId TEXT NOT NULL, PRIMARY KEY(kind, targetId));
CREATE TABLE IF NOT EXISTS sync_foreign(kind TEXT NOT NULL, id TEXT NOT NULL,
  workspace TEXT NOT NULL, role TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(kind, id));
CREATE TABLE IF NOT EXISTS sync_local(id TEXT PRIMARY KEY);
-- Remote rows this version could not apply (from a newer app, say). The sync
-- cursor moves past them, so they are kept here and retried on every pull.
CREATE TABLE IF NOT EXISTS sync_held(workspace TEXT NOT NULL, kind TEXT NOT NULL,
  boardId TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, row TEXT NOT NULL,
  PRIMARY KEY(workspace, kind, boardId, id));
DELETE FROM sync_state WHERE key='applying';
${triggerNames.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join('\n')}
DROP VIEW IF EXISTS sync_tracked;
CREATE VIEW sync_tracked AS
  SELECT b.id AS id, coalesce(fb.workspace, ff.workspace) AS foreign_ws,
    coalesce(fb.role, ff.role) AS role
  FROM boards b
  LEFT JOIN sync_foreign fb ON fb.kind='board' AND fb.id=b.id
  LEFT JOIN sync_foreign ff ON ff.kind='folder' AND ff.id=b.folderId
  WHERE b.id NOT IN (SELECT id FROM sync_local) AND (fb.id IS NOT NULL OR ff.id IS NOT NULL
    OR ${libraryOn} OR EXISTS (SELECT 1 FROM sync_owned o
      WHERE (o.kind='board' AND o.targetId=b.id) OR (o.kind='folder' AND o.targetId=b.folderId)));
CREATE TRIGGER sync_object_insert AFTER INSERT ON objects
  WHEN ${notApplying} AND ${editable('NEW.boardId')}
  BEGIN ${enqueue('object', 'NEW.boardId', 'NEW.id')} END;
CREATE TRIGGER sync_object_update AFTER UPDATE ON objects
  WHEN ${notApplying} AND ${editable('NEW.boardId')}
  BEGIN ${enqueue('object', 'NEW.boardId', 'NEW.id')} END;
CREATE TRIGGER sync_object_delete AFTER DELETE ON objects
  WHEN ${notApplying} AND ${editable('OLD.boardId')}
  BEGIN ${enqueue('object', 'OLD.boardId', 'OLD.id')} END;
CREATE TRIGGER sync_board_insert AFTER INSERT ON boards
  WHEN ${notApplying} AND ${ownTracked('NEW.id')}
  BEGIN ${enqueue('board', "''", 'NEW.id')} END;
CREATE TRIGGER sync_board_update AFTER UPDATE OF ${boardColumns} ON boards
  WHEN ${notApplying} AND (${ownTracked('NEW.id')} OR ${ownedFolder('OLD.folderId')})
  BEGIN ${enqueue('board', "''", 'NEW.id')} END;
-- A board moved into a shared folder brings its content along.
CREATE TRIGGER sync_board_moved AFTER UPDATE OF folderId ON boards
  WHEN ${notApplying} AND NEW.folderId IS NOT OLD.folderId AND NOT ${libraryOn}
    AND ${ownTracked('NEW.id')}
  BEGIN
    INSERT INTO sync_outbox SELECT 'object', NEW.id, id,
      (SELECT coalesce(max(queued), 0) + 1 FROM sync_outbox) FROM objects WHERE boardId=NEW.id
    ON CONFLICT(kind, boardId, id) DO UPDATE SET queued = excluded.queued;
  END;
CREATE TRIGGER sync_folder_insert AFTER INSERT ON folders
  WHEN ${notApplying} AND NOT ${foreignFolder('NEW.id')} AND (${libraryOn} OR ${ownedFolder('NEW.id')})
  BEGIN ${enqueue('folder', "''", 'NEW.id')} END;
CREATE TRIGGER sync_folder_update AFTER UPDATE ON folders
  WHEN ${notApplying} AND NOT ${foreignFolder('NEW.id')} AND (${libraryOn} OR ${ownedFolder('NEW.id')})
  BEGIN ${enqueue('folder', "''", 'NEW.id')} END;
CREATE TRIGGER sync_folder_delete AFTER DELETE ON folders
  WHEN ${notApplying} AND NOT ${foreignFolder('OLD.id')} AND (${libraryOn} OR ${ownedFolder('OLD.id')})
  BEGIN ${enqueue('folder', "''", 'OLD.id')} END;
`;

const dropForeignCopies = `
  DELETE FROM boards WHERE id IN (SELECT id FROM sync_foreign WHERE kind='board')
    OR folderId IN (SELECT id FROM sync_foreign WHERE kind='folder');
  DELETE FROM folders WHERE id IN (SELECT id FROM sync_foreign WHERE kind='folder');`;

const kindOrder = { folder: 0, board: 1, object: 2 };
const roleRank = { view: 1, edit: 2 };

// Every asset an object or board needs on another device.
function referencedAssets(kind, data, iconAssetId) {
  if (!data) return [];
  const ids =
    kind === 'board'
      ? [iconAssetId(data.icon), data.backgroundAssetId]
      : [
          data.assetId,
          data.linkIconId,
          data.documentPreviewId,
          ...(data.pdfComposer?.sources || []).map((s) => s.assetId),
          ...(data.album?.images || []).map((image) => image.assetId),
        ];
  return ids.filter((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id));
}

function createSync(store, helpers) {
  const db = () => store.db;
  // Libraries from before sharing: "enabled" meant the whole library synced.
  const uploaded = db().prepare("SELECT sql FROM sqlite_master WHERE name='sync_uploaded'").get();
  if (uploaded && !/workspace/.test(uploaded.sql)) db().exec('DROP TABLE sync_uploaded');
  db().exec(
    'CREATE TABLE IF NOT EXISTS sync_uploaded(workspace TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(workspace, id));',
  );
  db().exec('CREATE TABLE IF NOT EXISTS sync_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  if (db().prepare("SELECT 1 FROM sync_state WHERE key='enabled'").get())
    db().exec(
      "INSERT OR IGNORE INTO sync_state VALUES('library','1'); DELETE FROM sync_state WHERE key='enabled';",
    );
  db().exec(schema);

  const state = (key) =>
    db().prepare('SELECT value FROM sync_state WHERE key=?').get(key)?.value ?? null;
  const setState = (key, value) =>
    db()
      .prepare(
        'INSERT INTO sync_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, String(value));
  const cursorKey = (workspace) =>
    workspace === state('workspace') ? 'cursor' : 'cursor:' + workspace;
  const boardData = (b) => ({
    name: b.name,
    icon: b.icon,
    color: b.color,
    iconShape: b.iconShape,
    showInitial: !!b.showInitial,
    backgroundAssetId: b.backgroundAssetId,
    backgroundAppearance: JSON.parse(b.backgroundAppearance),
    folderId: b.folderId,
    position: b.position,
    trashed: !!b.trashed,
    created: b.created ?? null,
  });
  // Queue a folder or board this person owns, with all its content.
  const queueOwned = (kind, targetId) => {
    if (kind === 'folder')
      db().exec(`
        INSERT OR IGNORE INTO sync_outbox SELECT 'folder', '', id, 0 FROM folders WHERE id=${quote(targetId)};
        INSERT OR IGNORE INTO sync_outbox SELECT 'board', '', id, 0 FROM boards WHERE folderId=${quote(targetId)};
        INSERT OR IGNORE INTO sync_outbox SELECT 'object', o.boardId, o.id, 0 FROM objects o
          JOIN boards b ON b.id=o.boardId WHERE b.folderId=${quote(targetId)};`);
    else
      db().exec(`
        INSERT OR IGNORE INTO sync_outbox SELECT 'board', '', id, 0 FROM boards WHERE id=${quote(targetId)};
        INSERT OR IGNORE INTO sync_outbox SELECT 'object', boardId, id, 0 FROM objects WHERE boardId=${quote(targetId)};`);
  };
  const forgetOutbox = (boardId) => {
    db().prepare("DELETE FROM sync_outbox WHERE kind='board' AND id=?").run(boardId);
    db().prepare("DELETE FROM sync_outbox WHERE kind='object' AND boardId=?").run(boardId);
  };
  // Outbox entries for boards no longer in this library. Boards are only ever
  // deleted here when they were someone else's copy.
  const forgetOrphans = () =>
    db().exec(`
      DELETE FROM sync_outbox WHERE kind='object' AND boardId NOT IN (SELECT id FROM boards);
      DELETE FROM sync_outbox WHERE kind='board' AND id NOT IN (SELECT id FROM boards);`);
  const quote = (value) => "'" + String(helpers.idValue(value)).replace(/'/g, "''") + "'";
  const withApplying = (fn) =>
    store.transaction(() => {
      setState('applying', 1);
      try {
        return fn();
      } finally {
        db().prepare("DELETE FROM sync_state WHERE key='applying'").run();
      }
    });

  const sync = {
    status() {
      const workspace = state('workspace');
      return {
        identity: !!workspace,
        workspace,
        library: !!state('library'),
        enabled: !!state('library'),
        name: state('name') || '',
        cursor: Number(state('cursor') || 0),
        pending: db().prepare('SELECT count(*) AS n FROM sync_outbox').get().n,
        held: db().prepare('SELECT count(*) AS n FROM sync_held').get().n,
      };
    },
    // This library gets a personal workspace; nothing uploads until something is shared.
    identity({ workspace, name }) {
      helpers.idValue(workspace);
      return store.transaction(() => {
        if (typeof name === 'string' && name.trim()) setState('name', name.trim().slice(0, 60));
        if (state('workspace') !== workspace) {
          db().exec(
            'DELETE FROM sync_outbox; DELETE FROM sync_uploaded; DELETE FROM sync_owned; DELETE FROM sync_local; DELETE FROM sync_held;',
          );
          setState('workspace', workspace);
          setState('cursor', 0);
        }
        return sync.status();
      });
    },
    library({ on }) {
      if (!state('workspace')) throw Error('Turn on sync first');
      return store.transaction(() => {
        if (on) {
          setState('library', 1);
          db().exec(`
            INSERT OR IGNORE INTO sync_outbox SELECT 'folder', '', id, 0 FROM folders
              WHERE id NOT IN (SELECT id FROM sync_foreign WHERE kind='folder');
            INSERT OR IGNORE INTO sync_outbox SELECT 'board', '', id, 0 FROM sync_tracked
              WHERE foreign_ws IS NULL;
            INSERT OR IGNORE INTO sync_outbox SELECT 'object', o.boardId, o.id, 0 FROM objects o
              JOIN sync_tracked t ON t.id=o.boardId WHERE t.foreign_ws IS NULL;`);
        } else {
          db().exec(`
            DELETE FROM sync_state WHERE key='library';
            DELETE FROM sync_outbox WHERE kind='object' AND boardId NOT IN (SELECT id FROM sync_tracked);
            DELETE FROM sync_outbox WHERE kind='board' AND id NOT IN (SELECT id FROM sync_tracked);
            DELETE FROM sync_outbox WHERE kind='folder'
              AND id NOT IN (SELECT targetId FROM sync_owned WHERE kind='folder');`);
        }
        return sync.status();
      });
    },
    // Identity plus the whole library (turning sync on, or pairing a computer).
    enable({ workspace }) {
      sync.identity({ workspace });
      return sync.library({ on: true });
    },
    // Remove every copy of other people's boards and folders, with their unsent edits.
    dropForeign() {
      let changed = false;
      withApplying(() => {
        changed = !!db().prepare('SELECT 1 FROM sync_foreign LIMIT 1').get();
        db().exec(dropForeignCopies + 'DELETE FROM sync_foreign;');
        forgetOrphans();
      });
      return { changed };
    },
    disable() {
      withApplying(() => {
        // Boards other people shared here belong to them; remove the copies.
        db().exec(`${dropForeignCopies}
          DELETE FROM sync_outbox; DELETE FROM sync_uploaded; DELETE FROM sync_owned;
          DELETE FROM sync_foreign; DELETE FROM sync_local;
          DELETE FROM sync_state WHERE key <> 'applying';`);
      });
      return sync.status();
    },
    // Folders and boards this person shares, as listed by the server. Only a share
    // created here uploads its content (`upload`); learning about an existing share
    // must not resend local copies over newer edits from the people it is shared with.
    owned({ shares, upload = false }) {
      return store.transaction(() => {
        const before = new Set(
          db()
            .prepare('SELECT kind, targetId FROM sync_owned')
            .all()
            .map((s) => s.kind + ':' + s.targetId),
        );
        db().exec('DELETE FROM sync_owned');
        const add = db().prepare('INSERT OR REPLACE INTO sync_owned VALUES(?,?,?)');
        for (const s of shares) {
          helpers.idValue(s.targetId);
          add.run(s.kind, s.targetId, s.shareId);
          if (!upload || before.has(s.kind + ':' + s.targetId)) continue;
          // Sharing a board that was taken out of the cloud puts it back.
          const local =
            s.kind === 'board' &&
            db().prepare('DELETE FROM sync_local WHERE id=?').run(s.targetId).changes > 0;
          if (local || !state('library')) queueOwned(s.kind, s.targetId);
        }
        return sync.status();
      });
    },
    // Keep a board on this computer only: nothing of it is sent any more.
    keepLocal({ boardId }) {
      helpers.idValue(boardId);
      store.transaction(() => {
        if (!db().prepare('SELECT 1 FROM boards WHERE id=?').get(boardId))
          throw Error('This board is gone.');
        if (db().prepare('SELECT foreign_ws FROM sync_tracked WHERE id=?').get(boardId)?.foreign_ws)
          throw Error('Only the person who shared this board can remove it from the cloud.');
        db().prepare('INSERT OR IGNORE INTO sync_local VALUES(?)').run(boardId);
        forgetOutbox(boardId);
      });
      return { library: true, boards: [] };
    },
    // Bring boards shared with this person in line with what the server allows:
    // drop copies whose access ended, update rights, and report what to download.
    reconcile({ shares }) {
      const boards = new Map();
      const folders = new Map();
      const keep = (map, id, entry) => {
        const prior = map.get(id);
        if (!prior || roleRank[entry.role] > roleRank[prior.role]) map.set(id, entry);
      };
      for (const s of shares) {
        const entry = { workspace: s.workspace, role: s.role, owner: s.owner || '' };
        if (s.kind === 'folder') keep(folders, s.targetId, entry);
        for (const id of s.boards || []) keep(boards, id, entry);
      }
      let changed = false;
      withApplying(() => {
        const local = db().prepare('SELECT kind, id, role FROM sync_foreign').all();
        for (const f of local) {
          const wanted = (f.kind === 'board' ? boards : folders).get(f.id);
          if (!wanted) {
            if (f.kind === 'board') db().prepare('DELETE FROM boards WHERE id=?').run(f.id);
            else db().prepare('DELETE FROM folders WHERE id=?').run(f.id);
            db().prepare('DELETE FROM sync_foreign WHERE kind=? AND id=?').run(f.kind, f.id);
            changed = true;
          } else if (wanted.role !== f.role) {
            db()
              .prepare('UPDATE sync_foreign SET role=?, owner=? WHERE kind=? AND id=?')
              .run(wanted.role, wanted.owner, f.kind, f.id);
            changed = true;
          }
        }
        // Visitors never push the details of boards they do not own.
        db().exec(
          `DELETE FROM sync_outbox WHERE kind='board' AND id IN (SELECT id FROM sync_foreign WHERE kind='board')`,
        );
        // Edits waiting for a board that just went would be refused by the server.
        forgetOrphans();
      });
      const has = db().prepare('SELECT 1 FROM boards WHERE id=?');
      const hasFolder = db().prepare('SELECT 1 FROM folders WHERE id=?');
      const missing = new Map();
      const need = (workspace) => {
        if (!missing.has(workspace)) missing.set(workspace, { workspace, boards: [], folders: [] });
        return missing.get(workspace);
      };
      for (const [id, b] of boards) if (!has.get(id)) need(b.workspace).boards.push(id);
      for (const [id, f] of folders) if (!hasFolder.get(id)) need(f.workspace).folders.push(id);
      return {
        changed,
        missing: [...missing.values()],
        roles: {
          boards: Object.fromEntries([...boards].map(([id, b]) => [id, b])),
          folders: Object.fromEntries([...folders].map(([id, f]) => [id, f])),
        },
      };
    },
    // The next batch of local changes, each addressed to the workspace it belongs to.
    take({ limit = 200 } = {}) {
      const personal = state('workspace');
      if (!personal) return { entries: [], assets: [], dropped: [] };
      const rows = db()
        .prepare(
          `SELECT kind, boardId, id, queued FROM sync_outbox
          ORDER BY CASE kind WHEN 'folder' THEN 0 WHEN 'board' THEN 1 ELSE 2 END, queued LIMIT ?`,
        )
        .all(Math.max(1, Math.min(500, limit)));
      const folder = db().prepare('SELECT * FROM folders WHERE id=?');
      const board = db().prepare('SELECT * FROM boards WHERE id=?');
      const object = db().prepare('SELECT json FROM objects WHERE boardId=? AND id=?');
      const tracked = db().prepare('SELECT foreign_ws, role FROM sync_tracked WHERE id=?');
      const foreignBoard = db().prepare(
        "SELECT workspace, role FROM sync_foreign WHERE kind='board' AND id=?",
      );
      const isUploaded = db().prepare('SELECT 1 FROM sync_uploaded WHERE workspace=? AND id=?');
      const asset = db().prepare('SELECT * FROM assets WHERE id=?');
      const isLocal = db().prepare('SELECT 1 FROM sync_local WHERE id=?');
      const assets = new Map();
      const entries = [];
      const dropped = [];
      for (const r of rows) {
        if (r.kind !== 'folder' && isLocal.get(r.kind === 'board' ? r.id : r.boardId)) {
          dropped.push(r);
          continue;
        }
        let data = null;
        let workspace = personal;
        if (r.kind === 'folder') {
          const f = folder.get(r.id);
          data = f ? { name: f.name, position: f.position } : null;
        } else if (r.kind === 'board') {
          // Other people's boards are not renamed or moved from here.
          if (tracked.get(r.id)?.foreign_ws || foreignBoard.get(r.id)) {
            dropped.push(r);
            continue;
          }
          const b = board.get(r.id);
          data = b ? boardData(b) : null;
        } else {
          const t = tracked.get(r.boardId) || foreignBoard.get(r.boardId);
          const foreignWs = t?.foreign_ws || t?.workspace;
          if (foreignWs) {
            if (t.role !== 'edit') {
              dropped.push(r);
              continue;
            }
            workspace = foreignWs;
          }
          const o = object.get(r.boardId, r.id);
          data = o ? JSON.parse(o.json) : null;
        }
        for (const id of referencedAssets(r.kind, data, helpers.iconAssetId)) {
          const key = workspace + '/' + id;
          if (assets.has(key) || isUploaded.get(workspace, id)) continue;
          const a = asset.get(id);
          if (a)
            assets.set(key, {
              workspace,
              id,
              name: a.name,
              mime: a.mime,
              width: a.width,
              height: a.height,
              bytes: a.bytes,
              file: path.join(store.root, 'assets', id + '.original'),
            });
        }
        entries.push({
          workspace,
          kind: r.kind,
          board_id: r.boardId,
          id: r.id,
          data,
          deleted: data === null,
          queued: r.queued,
        });
      }
      return { entries, assets: [...assets.values()], dropped };
    },
    // Drop entries that were pushed, unless they changed again since `take`.
    ack({ entries = [], assets = [], dropped = [] }) {
      const drop = db().prepare(
        'DELETE FROM sync_outbox WHERE kind=? AND boardId=? AND id=? AND queued=?',
      );
      const mark = db().prepare('INSERT OR IGNORE INTO sync_uploaded VALUES(?,?)');
      const personal = state('workspace');
      store.transaction(() => {
        for (const e of [...entries, ...dropped])
          drop.run(e.kind, e.board_id ?? e.boardId, e.id, e.queued);
        for (const a of assets)
          typeof a === 'string' ? mark.run(personal, a) : mark.run(a.workspace, a.id);
      });
      return sync.status();
    },
    missingAssets({ ids }) {
      const has = db().prepare('SELECT 1 FROM assets WHERE id=?');
      return ids.filter((id) => /^[a-f0-9]{64}$/.test(id) && !has.get(id));
    },
    // Apply rows pulled from a workspace. Rows with a local unsent change are
    // skipped: that change is pushed next and becomes the newest version.
    // Rows from someone else's workspace become foreign boards with their rights.
    apply({ rows, cursor, workspace, roles }) {
      const personal = state('workspace');
      if (!personal) throw Error('Sync is off');
      workspace = workspace || personal;
      const foreign = workspace !== personal;
      if (cursor !== null && cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
        throw Error('Invalid sync cursor');
      const pending = db().prepare('SELECT 1 FROM sync_outbox WHERE kind=? AND boardId=? AND id=?');
      const markForeign = db().prepare(
        'INSERT INTO sync_foreign VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET workspace=excluded.workspace, role=excluded.role, owner=excluded.owner',
      );
      const isForeign = db().prepare(
        `SELECT 1 FROM boards b WHERE b.id=? AND (b.id IN (SELECT id FROM sync_foreign WHERE kind='board')
          OR b.folderId IN (SELECT id FROM sync_foreign WHERE kind='folder'))`,
      );
      const isLocal = db().prepare('SELECT 1 FROM sync_local WHERE id=?');
      const heldRows = db().prepare('SELECT row FROM sync_held WHERE workspace=?');
      const hold = db().prepare(
        'INSERT INTO sync_held VALUES(?,?,?,?,?) ON CONFLICT(workspace,kind,boardId,id) DO UPDATE SET row=excluded.row',
      );
      const release = db().prepare(
        'DELETE FROM sync_held WHERE workspace=? AND kind=? AND boardId=? AND id=?',
      );
      const touched = new Map();
      let library = false;
      const applyRow = (r) => {
        if (pending.get(r.kind, r.board_id || '', r.id)) return;
        if (r.kind === 'board' && !r.deleted && r.data?.removed) {
          // Taken out of the cloud on another computer: keep this copy, stop syncing it.
          if (!foreign && db().prepare('SELECT 1 FROM boards WHERE id=?').get(r.id)) {
            db().prepare('INSERT OR IGNORE INTO sync_local VALUES(?)').run(r.id);
            forgetOutbox(r.id);
            library = true;
          }
          return;
        }
        if (r.kind === 'object' && isLocal.get(r.board_id)) return;
        // Shared again from another computer: it syncs again.
        if (r.kind === 'board' && !foreign && !r.deleted)
          db().prepare('DELETE FROM sync_local WHERE id=?').run(r.id);
        if (foreign) {
          if (r.kind === 'folder') {
            const access = roles?.folders?.[r.id];
            if (!access) return;
            markForeign.run('folder', r.id, workspace, access.role, access.owner || '');
          } else if (r.kind === 'board') {
            const access = roles?.boards?.[r.id];
            if (!access) return;
            markForeign.run('board', r.id, workspace, access.role, access.owner || '');
          } else if (!isForeign.get(r.board_id)) return;
        }
        if (r.kind === 'folder') library = applyFolder(r) || library;
        else if (r.kind === 'board') library = applyBoard(r, foreign) || library;
        else if (applyObject(r)) {
          if (!touched.has(r.board_id)) touched.set(r.board_id, new Set());
          touched.get(r.board_id).add(r.id);
        }
      };
      withApplying(() => {
        const keyOf = (r) => r.kind + '\n' + (r.board_id || '') + '\n' + r.id;
        const incoming = new Set(rows.map(keyOf));
        // Rows held from earlier pulls, unless this pull brings a newer version.
        const earlier = heldRows
          .all(workspace)
          .map((h) => JSON.parse(h.row))
          .filter((r) => !incoming.has(keyOf(r)));
        const sorted = [...earlier, ...rows]
          .filter((r) => r.kind in kindOrder)
          .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.seq - b.seq);
        for (const r of sorted) {
          const key = [workspace, r.kind, r.board_id || '', r.id];
          // A savepoint, so a row that fails halfway leaves nothing behind.
          db().exec('SAVEPOINT sync_row');
          try {
            applyRow(r);
            db().exec('RELEASE sync_row');
            release.run(...key);
          } catch (e) {
            db().exec('ROLLBACK TO sync_row; RELEASE sync_row');
            // Kept for a later app version; the rest of the library keeps syncing.
            console.warn('Held remote ' + r.kind + ' ' + r.id + ': ' + e.message);
            hold.run(...key, JSON.stringify(r));
          }
        }
        for (const [boardId, ids] of touched) bumpRevision(boardId, ids);
        if (cursor !== null && cursor !== undefined) setState(cursorKey(workspace), cursor);
      });
      return { boards: [...touched.keys()], library };
    },
    // This person's picture and entrance song as local assets, with the versions
    // other people's apps use to notice changes.
    profile() {
      return {
        avatar: state('avatar'),
        avatarVersion: Number(state('avatarVersion') || 0),
        song: state('song'),
        songName: state('songName') || '',
        songVersion: Number(state('songVersion') || 0),
        publishSong: state('publishSong') !== '0',
      };
    },
    setProfile(patch) {
      const keys = ['avatar', 'avatarVersion', 'song', 'songName', 'songVersion', 'publishSong'];
      store.transaction(() => {
        for (const key of keys) {
          if (!(key in patch)) continue;
          const value = patch[key];
          if (value === null || value === undefined || value === '')
            db().prepare('DELETE FROM sync_state WHERE key=?').run(key);
          else setState(key, typeof value === 'boolean' ? (value ? 1 : 0) : value);
        }
      });
      return sync.profile();
    },
    rename({ name }) {
      if (typeof name !== 'string' || !name.trim()) throw Error('Enter a name');
      setState('name', name.trim().slice(0, 60));
      return sync.status();
    },
    cursor({ workspace }) {
      return Number(state(cursorKey(workspace)) || 0);
    },
    // Import a downloaded media file without queuing it for upload again.
    async importAsset({ bytes, name, workspace }) {
      const prepared = await store.importAsset({ bytes, name }, true);
      const result = prepared.data ? store.commitAsset(prepared) : prepared;
      db()
        .prepare('INSERT OR IGNORE INTO sync_uploaded VALUES(?,?)')
        .run(workspace || state('workspace') || '', result.id);
      return result;
    },
    // How each board and folder is shared, for the board panel and menus.
    marks() {
      const out = { boards: {}, folders: {}, local: [] };
      for (const s of db().prepare('SELECT kind, targetId FROM sync_owned').all())
        (s.kind === 'board' ? out.boards : out.folders)[s.targetId] = { shared: 'owner' };
      for (const f of db().prepare('SELECT kind, id, role, owner FROM sync_foreign').all())
        (f.kind === 'board' ? out.boards : out.folders)[f.id] = { shared: f.role, owner: f.owner };
      out.local = db()
        .prepare('SELECT id FROM sync_local')
        .all()
        .map((r) => r.id);
      return out;
    },
  };
  return sync;

  function applyFolder(r) {
    helpers.idValue(r.id);
    if (r.deleted) return db().prepare('DELETE FROM folders WHERE id=?').run(r.id).changes > 0;
    const name = helpers.nameValue(r.data.name);
    const position = helpers.number(r.data.position) ? r.data.position : 0;
    db()
      .prepare(
        'INSERT INTO folders VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,position=excluded.position',
      )
      .run(r.id, name, position);
    return true;
  }

  function applyBoard(r, foreign) {
    helpers.idValue(r.id);
    if (r.deleted) return false; // Boards are trashed, never removed.
    const d = r.data;
    const icon = helpers.validIcon(d.icon) ? d.icon : 'none';
    const color = ['blue', 'green', 'purple', 'orange', 'rose', 'gray', 'yellow'].includes(d.color)
      ? d.color
      : 'blue';
    const folderId =
      d.folderId && db().prepare('SELECT 1 FROM folders WHERE id=?').get(d.folderId)
        ? d.folderId
        : null;
    const hasAsset = (id) =>
      typeof id === 'string' && db().prepare('SELECT 1 FROM assets WHERE id=?').get(id);
    const values = [
      helpers.nameValue(d.name),
      helpers.iconAssetId(icon) && !hasAsset(helpers.iconAssetId(icon)) ? 'none' : icon,
      color,
      d.iconShape === 'circle' ? 'circle' : 'rounded',
      d.showInitial === false ? 0 : 1,
      hasAsset(d.backgroundAssetId) ? d.backgroundAssetId : null,
      JSON.stringify(helpers.backgroundAppearanceValue(d.backgroundAppearance || {})),
      folderId,
      helpers.number(d.position) ? d.position : 0,
      d.trashed ? 1 : 0,
      Date.now(),
    ];
    const exists = db().prepare('SELECT 1 FROM boards WHERE id=?').get(r.id);
    if (exists) {
      // A shared board keeps where the visitor placed it in their own panel.
      if (foreign)
        values[7] =
          folderId ?? db().prepare('SELECT folderId FROM boards WHERE id=?').get(r.id).folderId;
      db()
        .prepare(
          'UPDATE boards SET name=?,icon=?,color=?,iconShape=?,showInitial=?,backgroundAssetId=?,backgroundAppearance=?,folderId=?,position=?,trashed=?,updated=? WHERE id=?',
        )
        .run(...values, r.id);
    } else
      db()
        .prepare(
          'INSERT INTO boards(name,icon,color,iconShape,showInitial,backgroundAssetId,backgroundAppearance,folderId,position,trashed,updated,id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(...values, r.id);
    // The creating computer's time, when it recorded one.
    if (Number.isSafeInteger(d.created) && d.created > 0)
      db().prepare('UPDATE boards SET created=? WHERE id=?').run(d.created, r.id);
    return true;
  }

  function applyObject(r) {
    helpers.idValue(r.id);
    const board = db().prepare('SELECT revision FROM boards WHERE id=?').get(r.board_id);
    if (!board) return false;
    const before = db()
      .prepare('SELECT json FROM objects WHERE boardId=? AND id=?')
      .get(r.board_id, r.id)?.json;
    // Same revision bumpRevision gives this batch afterwards.
    const history = (after) =>
      store.recordHistory?.(r.board_id, r.id, board.revision + 1, before, after, 'cloud');
    if (r.deleted) {
      history(null);
      return (
        db().prepare('DELETE FROM objects WHERE boardId=? AND id=?').run(r.board_id, r.id).changes >
        0
      );
    }
    const o = helpers.objectValue(r.data);
    if (o.id !== r.id) throw Error('Object id mismatch');
    const json = JSON.stringify(o);
    history(json);
    db()
      .prepare(
        'INSERT INTO objects VALUES(?,?,?) ON CONFLICT(boardId,id) DO UPDATE SET json=excluded.json',
      )
      .run(r.board_id, r.id, json);
    return true;
  }

  // Same bookkeeping as a local save, so open editors and AI edits see a new revision.
  function bumpRevision(boardId, ids) {
    const b = db().prepare('SELECT revision FROM boards WHERE id=?').get(boardId);
    if (!b) return;
    const next = b.revision + 1;
    db().prepare('INSERT OR IGNORE INTO merge_floors VALUES(?,?)').run(boardId, b.revision);
    const track = db().prepare(
      'INSERT INTO object_revisions VALUES(?,?,?) ON CONFLICT(boardId,id) DO UPDATE SET revision=excluded.revision',
    );
    for (const id of ids) track.run(boardId, id, next);
    db()
      .prepare('UPDATE boards SET revision=revision+1,updated=? WHERE id=?')
      .run(Date.now(), boardId);
  }
}

module.exports = { createSync, referencedAssets };
