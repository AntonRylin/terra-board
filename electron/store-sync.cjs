const path = require('node:path');

// Local half of cloud sync. Triggers record what changed while sync is on; the
// sync loop takes those entries, pushes them and acknowledges them. Remote rows
// are applied under the `applying` flag so they never echo back into the outbox.
const syncing = `EXISTS (SELECT 1 FROM sync_state WHERE key='enabled')
  AND NOT EXISTS (SELECT 1 FROM sync_state WHERE key='applying')`;
const enqueue = (kind, boardId, id) =>
  `INSERT INTO sync_outbox VALUES('${kind}', ${boardId}, ${id},
    (SELECT coalesce(max(queued), 0) + 1 FROM sync_outbox))
  ON CONFLICT(kind, boardId, id) DO UPDATE SET queued = excluded.queued;`;
const boardColumns =
  'name,icon,color,iconShape,showInitial,backgroundAssetId,backgroundAppearance,folderId,position,trashed';

const schema = `
CREATE TABLE IF NOT EXISTS sync_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_outbox(kind TEXT NOT NULL, boardId TEXT NOT NULL DEFAULT '',
  id TEXT NOT NULL, queued INTEGER NOT NULL, PRIMARY KEY(kind, boardId, id));
CREATE INDEX IF NOT EXISTS sync_outbox_queued ON sync_outbox(queued);
CREATE TABLE IF NOT EXISTS sync_uploaded(id TEXT PRIMARY KEY);
DELETE FROM sync_state WHERE key='applying';
CREATE TRIGGER IF NOT EXISTS sync_object_insert AFTER INSERT ON objects WHEN ${syncing}
  BEGIN ${enqueue('object', 'NEW.boardId', 'NEW.id')} END;
CREATE TRIGGER IF NOT EXISTS sync_object_update AFTER UPDATE ON objects WHEN ${syncing}
  BEGIN ${enqueue('object', 'NEW.boardId', 'NEW.id')} END;
CREATE TRIGGER IF NOT EXISTS sync_object_delete AFTER DELETE ON objects WHEN ${syncing}
  BEGIN ${enqueue('object', 'OLD.boardId', 'OLD.id')} END;
CREATE TRIGGER IF NOT EXISTS sync_board_insert AFTER INSERT ON boards WHEN ${syncing}
  BEGIN ${enqueue('board', "''", 'NEW.id')} END;
CREATE TRIGGER IF NOT EXISTS sync_board_update AFTER UPDATE OF ${boardColumns} ON boards WHEN ${syncing}
  BEGIN ${enqueue('board', "''", 'NEW.id')} END;
CREATE TRIGGER IF NOT EXISTS sync_folder_insert AFTER INSERT ON folders WHEN ${syncing}
  BEGIN ${enqueue('folder', "''", 'NEW.id')} END;
CREATE TRIGGER IF NOT EXISTS sync_folder_update AFTER UPDATE ON folders WHEN ${syncing}
  BEGIN ${enqueue('folder', "''", 'NEW.id')} END;
CREATE TRIGGER IF NOT EXISTS sync_folder_delete AFTER DELETE ON folders WHEN ${syncing}
  BEGIN ${enqueue('folder', "''", 'OLD.id')} END;
`;

const kindOrder = { folder: 0, board: 1, object: 2 };

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
  db().exec(schema);
  const state = (key) =>
    db().prepare('SELECT value FROM sync_state WHERE key=?').get(key)?.value ?? null;
  const setState = (key, value) =>
    db()
      .prepare(
        'INSERT INTO sync_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, String(value));
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

  return {
    status() {
      return {
        enabled: !!state('enabled'),
        workspace: state('workspace'),
        cursor: Number(state('cursor') || 0),
        pending: db().prepare('SELECT count(*) AS n FROM sync_outbox').get().n,
      };
    },
    // Start syncing this library into a workspace; everything local is queued.
    enable({ workspace }) {
      helpers.idValue(workspace);
      return store.transaction(() => {
        db().exec('DELETE FROM sync_state; DELETE FROM sync_outbox; DELETE FROM sync_uploaded;');
        setState('enabled', 1);
        setState('workspace', workspace);
        setState('cursor', 0);
        db().exec(`
          INSERT INTO sync_outbox SELECT 'folder', '', id, 0 FROM folders;
          INSERT INTO sync_outbox SELECT 'board', '', id, 0 FROM boards;
          INSERT INTO sync_outbox SELECT 'object', boardId, id, 0 FROM objects;`);
        return this.status();
      });
    },
    disable() {
      db().exec('DELETE FROM sync_state; DELETE FROM sync_outbox; DELETE FROM sync_uploaded;');
      return this.status();
    },
    // The next batch of local changes with their current content. Assets they
    // reference that were never uploaded come first so other devices can show them.
    take({ limit = 200 } = {}) {
      if (!state('enabled')) return { entries: [], assets: [] };
      const rows = db()
        .prepare(
          `SELECT kind, boardId, id, queued FROM sync_outbox
          ORDER BY CASE kind WHEN 'folder' THEN 0 WHEN 'board' THEN 1 ELSE 2 END, queued LIMIT ?`,
        )
        .all(Math.max(1, Math.min(500, limit)));
      const folder = db().prepare('SELECT * FROM folders WHERE id=?');
      const board = db().prepare('SELECT * FROM boards WHERE id=?');
      const object = db().prepare('SELECT json FROM objects WHERE boardId=? AND id=?');
      const uploaded = db().prepare('SELECT 1 FROM sync_uploaded WHERE id=?');
      const asset = db().prepare('SELECT * FROM assets WHERE id=?');
      const assets = new Map();
      const entries = rows.map((r) => {
        let data = null;
        if (r.kind === 'folder') {
          const f = folder.get(r.id);
          data = f ? { name: f.name, position: f.position } : null;
        } else if (r.kind === 'board') {
          const b = board.get(r.id);
          data = b ? boardData(b) : null;
        } else {
          const o = object.get(r.boardId, r.id);
          data = o ? JSON.parse(o.json) : null;
        }
        for (const id of referencedAssets(r.kind, data, helpers.iconAssetId)) {
          if (assets.has(id) || uploaded.get(id)) continue;
          const a = asset.get(id);
          if (a)
            assets.set(id, {
              id,
              name: a.name,
              mime: a.mime,
              width: a.width,
              height: a.height,
              bytes: a.bytes,
              file: path.join(store.root, 'assets', id + '.original'),
            });
        }
        return {
          kind: r.kind,
          board_id: r.boardId,
          id: r.id,
          data,
          deleted: data === null,
          queued: r.queued,
        };
      });
      return { entries, assets: [...assets.values()] };
    },
    // Drop entries that were pushed, unless they changed again since `take`.
    ack({ entries = [], assets = [] }) {
      const drop = db().prepare(
        'DELETE FROM sync_outbox WHERE kind=? AND boardId=? AND id=? AND queued=?',
      );
      const mark = db().prepare('INSERT OR IGNORE INTO sync_uploaded VALUES(?)');
      store.transaction(() => {
        for (const e of entries) drop.run(e.kind, e.board_id, e.id, e.queued);
        for (const id of assets) mark.run(id);
      });
      return this.status();
    },
    missingAssets({ ids }) {
      const has = db().prepare('SELECT 1 FROM assets WHERE id=?');
      return ids.filter((id) => /^[a-f0-9]{64}$/.test(id) && !has.get(id));
    },
    // Apply rows pulled from the server. Rows with a local unsent change are
    // skipped: that change is pushed next and becomes the newest version.
    apply({ rows, cursor }) {
      if (!state('enabled')) throw Error('Sync is off');
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error('Invalid sync cursor');
      const pending = db().prepare('SELECT 1 FROM sync_outbox WHERE kind=? AND boardId=? AND id=?');
      const touched = new Map();
      let library = false;
      store.transaction(() => {
        setState('applying', 1);
        try {
          const sorted = rows
            .filter((r) => r.kind in kindOrder)
            .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.seq - b.seq);
          for (const r of sorted) {
            if (pending.get(r.kind, r.board_id || '', r.id)) continue;
            try {
              if (r.kind === 'folder') library = applyFolder(r) || library;
              else if (r.kind === 'board') library = applyBoard(r) || library;
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
          setState('cursor', cursor);
        } finally {
          db().prepare("DELETE FROM sync_state WHERE key='applying'").run();
        }
      });
      return { boards: [...touched.keys()], library };
    },
    // Import a downloaded media file without queuing it for upload again.
    async importAsset({ bytes, name }) {
      const prepared = await store.importAsset({ bytes, name }, true);
      if (!prepared.data) return prepared;
      const result = store.commitAsset(prepared);
      db().prepare('INSERT OR IGNORE INTO sync_uploaded VALUES(?)').run(result.id);
      return result;
    },
  };

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

  function applyBoard(r) {
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
    if (exists)
      db()
        .prepare(
          'UPDATE boards SET name=?,icon=?,color=?,iconShape=?,showInitial=?,backgroundAssetId=?,backgroundAppearance=?,folderId=?,position=?,trashed=?,updated=? WHERE id=?',
        )
        .run(...values, r.id);
    else
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
