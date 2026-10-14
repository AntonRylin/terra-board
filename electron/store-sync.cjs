const path = require('node:path');

// Local half of cloud sync.
//
// A library has at most one personal cloud workspace (its "identity"). Boards
// are tracked when the whole library syncs, when this person shares them (or
// their folder), or when someone else shared them here ("foreign" boards, which
// belong to the sharer's workspace). Triggers record changes to tracked boards
// in an outbox; the sync loop takes, pushes and acknowledges those entries.
// Remote rows are applied under the `applying` flag so they never echo back.
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
DELETE FROM sync_state WHERE key='applying';
${triggerNames.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join('\n')}
DROP VIEW IF EXISTS sync_tracked;
CREATE VIEW sync_tracked AS
  SELECT b.id AS id, coalesce(fb.workspace, ff.workspace) AS foreign_ws,
    coalesce(fb.role, ff.role) AS role
  FROM boards b
  LEFT JOIN sync_foreign fb ON fb.kind='board' AND fb.id=b.id
  LEFT JOIN sync_foreign ff ON ff.kind='folder' AND ff.id=b.folderId
  WHERE fb.id IS NOT NULL OR ff.id IS NOT NULL OR ${libraryOn}
    OR EXISTS (SELECT 1 FROM sync_owned o
      WHERE (o.kind='board' AND o.targetId=b.id) OR (o.kind='folder' AND o.targetId=b.folderId));
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
      };
    },
    // This library gets a personal workspace; nothing uploads until something is shared.
    identity({ workspace, name }) {
      helpers.idValue(workspace);
      return store.transaction(() => {
        if (typeof name === 'string' && name.trim()) setState('name', name.trim().slice(0, 60));
        if (state('workspace') !== workspace) {
          db().exec('DELETE FROM sync_outbox; DELETE FROM sync_uploaded; DELETE FROM sync_owned;');
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
    disable() {
      withApplying(() => {
        // Boards other people shared here belong to them; remove the copies.
        db().exec(`
          DELETE FROM boards WHERE id IN (SELECT id FROM sync_foreign WHERE kind='board')
            OR folderId IN (SELECT id FROM sync_foreign WHERE kind='folder');
          DELETE FROM folders WHERE id IN (SELECT id FROM sync_foreign WHERE kind='folder');
          DELETE FROM sync_outbox; DELETE FROM sync_uploaded; DELETE FROM sync_owned;
          DELETE FROM sync_foreign; DELETE FROM sync_state WHERE key <> 'applying';`);
      });
      return sync.status();
    },
    // Folders and boards this person shares, as listed by the server.
    owned({ shares }) {
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
          if (!before.has(s.kind + ':' + s.targetId) && !state('library'))
            queueOwned(s.kind, s.targetId);
        }
        return sync.status();
      });
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
      const assets = new Map();
      const entries = [];
      const dropped = [];
      for (const r of rows) {
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
      const touched = new Map();
      let library = false;
      withApplying(() => {
        const sorted = rows
          .filter((r) => r.kind in kindOrder)
          .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.seq - b.seq);
        for (const r of sorted) {
          if (pending.get(r.kind, r.board_id || '', r.id)) continue;
          try {
            if (foreign) {
              if (r.kind === 'folder') {
                const access = roles?.folders?.[r.id];
                if (!access) continue;
                markForeign.run('folder', r.id, workspace, access.role, access.owner || '');
              } else if (r.kind === 'board') {
                const access = roles?.boards?.[r.id];
                if (!access) continue;
                markForeign.run('board', r.id, workspace, access.role, access.owner || '');
              } else if (!isForeign.get(r.board_id)) continue;
            }
            if (r.kind === 'folder') library = applyFolder(r) || library;
            else if (r.kind === 'board') library = applyBoard(r, foreign) || library;
            else if (applyObject(r)) {
              if (!touched.has(r.board_id)) touched.set(r.board_id, new Set());
              touched.get(r.board_id).add(r.id);
            }
          } catch (e) {
            // A malformed remote row must not stop the rest of the library syncing.
            console.warn('Skipped remote ' + r.kind + ' ' + r.id + ': ' + e.message);
          }
        }
        for (const [boardId, ids] of touched) bumpRevision(boardId, ids);
        if (cursor !== null && cursor !== undefined) setState(cursorKey(workspace), cursor);
      });
      return { boards: [...touched.keys()], library };
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
      const out = { boards: {}, folders: {} };
      for (const s of db().prepare('SELECT kind, targetId FROM sync_owned').all())
        (s.kind === 'board' ? out.boards : out.folders)[s.targetId] = { shared: 'owner' };
      for (const f of db().prepare('SELECT kind, id, role, owner FROM sync_foreign').all())
        (f.kind === 'board' ? out.boards : out.folders)[f.id] = { shared: f.role, owner: f.owner };
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
    return true;
  }

  function applyObject(r) {
    helpers.idValue(r.id);
    if (!db().prepare('SELECT 1 FROM boards WHERE id=?').get(r.board_id)) return false;
    if (r.deleted)
      return (
        db().prepare('DELETE FROM objects WHERE boardId=? AND id=?').run(r.board_id, r.id).changes >
        0
      );
    const o = helpers.objectValue(r.data);
    if (o.id !== r.id) throw Error('Object id mismatch');
    db()
      .prepare(
        'INSERT INTO objects VALUES(?,?,?) ON CONFLICT(boardId,id) DO UPDATE SET json=excluded.json',
      )
      .run(r.board_id, r.id, JSON.stringify(o));
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
