const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const sharp = require('sharp');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

const iconAssetId = (icon) =>
  typeof icon === 'string' && /^asset-[a-f0-9]{64}$/.test(icon) ? icon.slice(6) : null;
const validIcon = (icon) =>
  typeof icon === 'string' &&
  (/^[a-z0-9-]{1,40}$/.test(icon) ||
    !!iconAssetId(icon) ||
    (icon.startsWith('emoji:') &&
      icon.length <= 85 &&
      graphemes(icon.slice(6)).length === 1 &&
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(icon.slice(6))));

const MAX_PACKAGE = 512 * 1024 * 1024;
const graphemes = (value) =>
  [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(value)].map((s) => s.segment);
const types = new Set([
  'text',
  'note',
  'rect',
  'ellipse',
  'frame',
  'image',
  'video',
  'link',
  'arrow',
]);
const idValue = (value) => {
  if (typeof value !== 'string' || !value || value.length > 100 || !/^[\w-]+$/.test(value))
    throw Error('Invalid identifier');
  return value;
};
const nameValue = (value) => {
  if (
    typeof value !== 'string' ||
    value.length > 10000 ||
    !value.trim() ||
    graphemes(value.trim()).length > 120
  )
    throw Error('Names must contain 1–120 characters');
  return value.trim();
};
const number = (value, min = -1e9, max = 1e9) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
function cameraValue(c) {
  if (!c || !number(c.x) || !number(c.y) || !number(c.zoom, 0.01, 16))
    throw Error('Invalid camera');
  return { x: c.x, y: c.y, zoom: c.zoom };
}
function objectValue(o) {
  if (
    !o ||
    !types.has(o.type) ||
    !number(o.x) ||
    !number(o.y) ||
    !number(o.width, 1, 1e6) ||
    !number(o.height, 1, 1e6) ||
    !number(o.z, -1e7, 1e7)
  )
    throw Error('Invalid canvas object');
  const result = {
    id: idValue(o.id),
    type: o.type,
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    z: o.z,
  };
  if (o.type === 'arrow') {
    const a = o.arrow;
    if (
      !a ||
      !Array.isArray(a.points) ||
      a.points.length < 2 ||
      a.points.length > 32 ||
      !a.points.every(
        (p) =>
          p &&
          Number.isFinite(p.x) &&
          Number.isFinite(p.y) &&
          p.x >= 0 &&
          p.x <= 1 &&
          p.y >= 0 &&
          p.y <= 1,
      ) ||
      !['straight', 'curve', 'elbow'].includes(a.line) ||
      !['none', 'arrow', 'triangle', 'open', 'diamond', 'circle'].includes(a.start) ||
      !['none', 'arrow', 'triangle', 'open', 'diamond', 'circle'].includes(a.end) ||
      !['solid', 'dashed', 'dotted'].includes(a.dash) ||
      !Number.isFinite(a.thickness) ||
      a.thickness < 0.5 ||
      a.thickness > 40
    )
      throw Error('Invalid arrow');
    result.arrow = {
      points: a.points.map((p) => ({ x: p.x, y: p.y })),
      line: a.line,
      start: a.start,
      end: a.end,
      dash: a.dash,
      thickness: a.thickness,
    };
  }
  if (o.text !== undefined) {
    if (typeof o.text !== 'string' || o.text.length > 100000) throw Error('Invalid text');
    result.text = o.text;
  }
  if (o.imageTitle !== undefined) {
    if (o.type !== 'image' || typeof o.imageTitle !== 'string' || o.imageTitle.length > 100000)
      throw Error('Invalid image title');
    result.imageTitle = o.imageTitle;
  }
  if (o.color !== undefined) {
    if (!/^#[a-fA-F0-9]{6}$/.test(o.color)) throw Error('Invalid color');
    result.color = o.color;
  }
  if (o.fontSize !== undefined) {
    if (!number(o.fontSize, 8, 300)) throw Error('Invalid font size');
    result.fontSize = o.fontSize;
  }
  if (o.rotation !== undefined) {
    if (!number(o.rotation, 0, 360)) throw Error('Invalid rotation');
    result.rotation = o.rotation;
  }
  for (const key of ['centerX', 'centerY', 'textBox', 'bold', 'strikethrough']) {
    if (o[key] !== undefined) {
      if (typeof o[key] !== 'boolean') throw Error('Invalid text alignment or formatting');
      result[key] = o[key];
    }
  }
  if (o.groupId) result.groupId = idValue(o.groupId);
  if (o.gallery !== undefined) {
    const g = o.gallery;
    if (
      o.type !== 'frame' ||
      !g ||
      !['right', 'below'].includes(g.direction) ||
      !number(g.size, 32, 8192) ||
      !number(g.gap, 0, 200) ||
      (o.rotation || 0) !== 0
    )
      throw Error('Invalid gallery');
    result.gallery = { direction: g.direction, size: g.size, gap: g.gap };
  }
  if (o.galleryId !== undefined) {
    if (o.type !== 'image' || !number(o.galleryIndex, 0, 1e7)) throw Error('Invalid gallery image');
    result.galleryId = idValue(o.galleryId);
    result.galleryIndex = o.galleryIndex;
    if (o.galleryRow !== undefined || o.galleryColumn !== undefined) {
      if (
        !Number.isInteger(o.galleryRow) ||
        !number(o.galleryRow, 0, 10000) ||
        !Number.isInteger(o.galleryColumn) ||
        !number(o.galleryColumn, 0, 10000)
      )
        throw Error('Invalid gallery cell');
      result.galleryRow = o.galleryRow;
      result.galleryColumn = o.galleryColumn;
    }
  }
  if (o.assetId) result.assetId = idValue(o.assetId);
  if (o.type === 'link' && o.linkIconId) result.linkIconId = idValue(o.linkIconId);
  if (o.type === 'link' && o.linkCompact !== undefined) {
    if (typeof o.linkCompact !== 'boolean') throw Error('Invalid link appearance');
    result.linkCompact = o.linkCompact;
  }
  if (o.type === 'link' && o.linkPreviewHeight !== undefined) {
    if (!number(o.linkPreviewHeight, 1, 1e6)) throw Error('Invalid link preview height');
    result.linkPreviewHeight = o.linkPreviewHeight;
  }
  if (o.crop !== undefined) {
    const c = o.crop;
    if (
      o.type !== 'image' ||
      !c ||
      !number(c.x, 0, 1) ||
      !number(c.y, 0, 1) ||
      !number(c.width, 1e-6, 1) ||
      !number(c.height, 1e-6, 1) ||
      c.x + c.width > 1 + 1e-9 ||
      c.y + c.height > 1 + 1e-9
    )
      throw Error('Invalid image crop');
    result.crop = { x: c.x, y: c.y, width: c.width, height: c.height };
  }
  if (o.type === 'image' || o.type === 'video') {
    if (!o.assetId) throw Error('Missing asset');
  }
  if (o.type === 'link') {
    if (typeof o.url !== 'string' || o.url.length > 8192) throw Error('Invalid URL');
    let u;
    try {
      u = new URL(o.url);
    } catch {
      throw Error('Invalid URL');
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw Error('Invalid URL protocol');
    result.url = u.href;
    if (o.linkDescription !== undefined) {
      if (typeof o.linkDescription !== 'string' || o.linkDescription.length > 500)
        throw Error('Invalid link description');
      result.linkDescription = o.linkDescription;
    }
  }
  return result;
}
function durableWrite(file, bytes) {
  if (fs.existsSync(file)) return;
  const tmp = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
class Store {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
    this.db = new DatabaseSync(path.join(root, 'library.sqlite'));
    if (this.db.prepare('PRAGMA user_version').get().user_version > 1) {
      this.db.close();
      throw Error(
        'This library was created by a newer version of Terra Board. Update the app to open it.',
      );
    }
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY,name TEXT NOT NULL,position REAL NOT NULL);
   CREATE TABLE IF NOT EXISTS boards(id TEXT PRIMARY KEY,name TEXT NOT NULL,icon TEXT NOT NULL,color TEXT NOT NULL,folderId TEXT REFERENCES folders(id) ON DELETE SET NULL,position REAL NOT NULL,trashed INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,camera TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',updated INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS objects(boardId TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(boardId,id));
   CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,name TEXT NOT NULL,mime TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,bytes INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS operations(boardId TEXT NOT NULL REFERENCES boards(id),id TEXT NOT NULL,revision INTEGER NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(boardId,id));
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=1;`);
    if (
      !this.db
        .prepare('PRAGMA table_info(boards)')
        .all()
        .some((column) => column.name === 'iconShape')
    )
      this.db.exec("ALTER TABLE boards ADD COLUMN iconShape TEXT NOT NULL DEFAULT 'rounded'");
    if (
      !this.db
        .prepare('PRAGMA table_info(boards)')
        .all()
        .some((column) => column.name === 'showInitial')
    )
      this.db.exec('ALTER TABLE boards ADD COLUMN showInitial INTEGER NOT NULL DEFAULT 1');
    const backup = path.join(root, 'backups', new Date().toISOString().slice(0, 10) + '.sqlite');
    if (!fs.existsSync(backup) && this.db.prepare('SELECT count(*) AS n FROM boards').get().n) {
      try {
        this.db.exec("VACUUM INTO '" + backup.replace(/'/g, "''") + "'");
      } catch (e) {
        this.backupError = e.message;
      }
    }
  }
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  library() {
    return {
      boards: this.db
        .prepare(
          'SELECT id,name,icon,color,iconShape,showInitial,folderId,position,trashed,updated FROM boards ORDER BY position',
        )
        .all()
        .map((b) => ({ ...b, trashed: !!b.trashed, showInitial: !!b.showInitial })),
      folders: this.db.prepare('SELECT * FROM folders ORDER BY position').all(),
      lastBoard:
        this.db.prepare("SELECT value FROM settings WHERE key='lastBoard'").get()?.value || null,
      backupError: this.backupError || null,
    };
  }
  board(id) {
    const b = this.db.prepare('SELECT * FROM boards WHERE id=?').get(idValue(id));
    if (!b) throw Error('Board not found');
    return { ...b, trashed: !!b.trashed, showInitial: !!b.showInitial };
  }
  position() {
    return (
      this.db
        .prepare(
          'SELECT max(n) AS p FROM (SELECT max(position) AS n FROM boards UNION ALL SELECT max(position) FROM folders)',
        )
        .get().p + 1 || 1
    );
  }
  folderId(id) {
    if (id === null || id === undefined) return null;
    if (!this.db.prepare('SELECT id FROM folders WHERE id=?').get(idValue(id)))
      throw Error('Folder not found');
    return id;
  }
  createBoard({ name, folderId = null }) {
    const b = {
      id: randomUUID(),
      name: nameValue(name),
      icon: 'none',
      showInitial: true,
      color: 'blue',
      folderId: this.folderId(folderId),
      position: this.position(),
      updated: Date.now(),
      trashed: false,
    };
    this.db
      .prepare(
        'INSERT INTO boards(id,name,icon,color,folderId,position,updated) VALUES(?,?,?,?,?,?,?)',
      )
      .run(b.id, b.name, b.icon, b.color, b.folderId, b.position, b.updated);
    return b;
  }
  createFolder({ name }) {
    const f = { id: randomUUID(), name: nameValue(name), position: this.position() };
    this.db.prepare('INSERT INTO folders VALUES(?,?,?)').run(f.id, f.name, f.position);
    return f;
  }
  updateFolder({ id, patch }) {
    idValue(id);
    const f = this.db.prepare('SELECT * FROM folders WHERE id=?').get(id);
    if (!f) throw Error('Folder not found');
    const name = patch.name === undefined ? f.name : nameValue(patch.name),
      position = patch.position === undefined ? f.position : patch.position;
    if (!number(position)) throw Error('Invalid order');
    this.db.prepare('UPDATE folders SET name=?,position=? WHERE id=?').run(name, position, id);
    return { id, name, position };
  }
  removeFolder({ id }) {
    idValue(id);
    this.db.prepare('DELETE FROM folders WHERE id=?').run(id);
    return this.library();
  }
  updateBoard({ id, patch }) {
    const b = this.board(id);
    if (!patch || typeof patch !== 'object') throw Error('Invalid board update');
    if (patch.name !== undefined) b.name = nameValue(patch.name);
    if (patch.icon !== undefined) {
      if (!validIcon(patch.icon)) throw Error('Invalid icon');
      const assetId = iconAssetId(patch.icon);
      if (
        assetId &&
        !this.db.prepare("SELECT id FROM assets WHERE id=? AND mime LIKE 'image/%'").get(assetId)
      )
        throw Error('Missing image for board icon');
      b.icon = patch.icon;
    }
    if (patch.color !== undefined) {
      if (!['blue', 'green', 'purple', 'orange', 'rose', 'gray', 'yellow'].includes(patch.color))
        throw Error('Invalid color');
      b.color = patch.color;
    }
    if (patch.iconShape !== undefined) {
      if (!['rounded', 'circle'].includes(patch.iconShape)) throw Error('Invalid icon shape');
      b.iconShape = patch.iconShape;
    }
    if (patch.showInitial !== undefined) {
      if (typeof patch.showInitial !== 'boolean') throw Error('Invalid initial visibility');
      b.showInitial = patch.showInitial;
    }
    if ('folderId' in patch) b.folderId = this.folderId(patch.folderId);
    if ('position' in patch) {
      if (!number(patch.position)) throw Error('Invalid order');
      b.position = patch.position;
    }
    if ('trashed' in patch) {
      if (typeof patch.trashed !== 'boolean') throw Error('Invalid trash value');
      b.trashed = patch.trashed;
    }
    this.db
      .prepare(
        'UPDATE boards SET name=?,icon=?,color=?,iconShape=?,showInitial=?,folderId=?,position=?,trashed=?,updated=? WHERE id=?',
      )
      .run(
        b.name,
        b.icon,
        b.color,
        b.iconShape,
        +b.showInitial,
        b.folderId,
        b.position,
        +b.trashed,
        Date.now(),
        id,
      );
    return { ...b, camera: undefined };
  }
  restoreBoard({ id }) {
    return this.updateBoard({ id, patch: { trashed: false } });
  }
  loadBoard({ id }) {
    const b = this.board(id);
    return {
      board: b,
      objects: this.db
        .prepare('SELECT json FROM objects WHERE boardId=?')
        .all(id)
        .map((r) => JSON.parse(r.json)),
      camera: JSON.parse(b.camera),
      revision: b.revision,
    };
  }
  patchBoard({ id, revision, upserts = [], deleted = [], camera, operationId }) {
    if (
      !Array.isArray(upserts) ||
      !Array.isArray(deleted) ||
      upserts.length > 100000 ||
      deleted.length > 100000
    )
      throw Error('Invalid edit size');
    const objects = upserts.map(objectValue);
    deleted.forEach(idValue);
    if (camera) camera = cameraValue(camera);
    if (operationId) idValue(operationId);
    const signature = createHash('sha256')
      .update(JSON.stringify({ revision, objects, deleted, camera }))
      .digest('hex');
    const findAsset = this.db.prepare('SELECT id FROM assets WHERE id=?');
    for (const o of objects) {
      if (o.assetId && !findAsset.get(o.assetId)) throw Error('Missing media asset');
      if (o.linkIconId && !findAsset.get(o.linkIconId)) throw Error('Missing site icon');
    }
    return this.transaction(() => {
      if (operationId) {
        const prior = this.db
          .prepare('SELECT revision,signature FROM operations WHERE boardId=? AND id=?')
          .get(id, operationId);
        if (prior) {
          if (prior.signature !== signature) throw Error('Save operation identifier was reused');
          return { revision: prior.revision };
        }
      }
      const b = this.board(id);
      if (b.revision !== revision) throw Error('Board revision changed; reload before editing');
      const write = this.db.prepare(
        'INSERT INTO objects VALUES(?,?,?) ON CONFLICT(boardId,id) DO UPDATE SET json=excluded.json',
      );
      const del = this.db.prepare('DELETE FROM objects WHERE boardId=? AND id=?');
      for (const o of objects) write.run(id, o.id, JSON.stringify(o));
      for (const oid of deleted) del.run(id, oid);
      this.db
        .prepare('UPDATE boards SET revision=revision+1,camera=?,updated=? WHERE id=?')
        .run(camera ? JSON.stringify(camera) : b.camera, Date.now(), id);
      if (operationId) {
        this.db
          .prepare('INSERT INTO operations VALUES(?,?,?,?)')
          .run(id, operationId, revision + 1, signature);
        this.db
          .prepare('DELETE FROM operations WHERE boardId=? AND revision<?')
          .run(id, revision - 500);
      }
      return { revision: revision + 1 };
    });
  }
  duplicateBoard({ id }) {
    return this.transaction(() => {
      const original = this.board(id),
        copy = this.createBoard({
          name: graphemes(original.name).slice(0, 110).join('') + ' copy',
          folderId: original.folderId,
        });
      this.db
        .prepare('UPDATE boards SET icon=?,color=?,iconShape=?,showInitial=?,camera=? WHERE id=?')
        .run(
          original.icon,
          original.color,
          original.iconShape,
          +original.showInitial,
          original.camera,
          copy.id,
        );
      this.db
        .prepare('INSERT INTO objects SELECT ?,id,json FROM objects WHERE boardId=?')
        .run(copy.id, id);
      return {
        ...copy,
        icon: original.icon,
        color: original.color,
        iconShape: original.iconShape,
        showInitial: original.showInitial,
      };
    });
  }
  setLastBoard({ id }) {
    this.board(id);
    this.db
      .prepare(
        "INSERT INTO settings VALUES('lastBoard',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(id);
    return true;
  }
  async importAsset({ bytes, name }, prepareOnly = false) {
    name = String(name || 'image.png').slice(0, 240);
    let data = Buffer.from(bytes);
    if (!data.length || data.length > 256 * 1024 * 1024)
      throw Error('Files must be between 1 byte and 256 MB in this version');
    if (data.length >= 4 && data.readUInt32LE(0) === 0x00010000) {
      data = await require('./icon-image.cjs').iconPng(data);
      name = name.replace(/\.[^.]+$/, '') + '.png';
    }
    const id = createHash('sha256').update(data).digest('hex');
    const existing = this.db.prepare('SELECT * FROM assets WHERE id=?').get(id);
    if (existing) return existing;
    let mime, width, height, preview, thumbnail;
    const ext = path.extname(name).toLowerCase();
    if (['.mp4', '.webm'].includes(ext)) {
      const valid =
        ext === '.mp4'
          ? data.subarray(4, 8).toString() === 'ftyp'
          : data.readUInt32BE(0) === 0x1a45dfa3;
      if (!valid) throw Error('Unsupported video file');
      mime = ext === '.mp4' ? 'video/mp4' : 'video/webm';
      width = 1280;
      height = 720;
    } else {
      const input = sharp(data, { limitInputPixels: 100000000, animated: false });
      const m = await input.metadata();
      if (!['jpeg', 'png', 'webp', 'gif', 'avif', 'tiff'].includes(m.format))
        throw Error('Use a PNG, JPEG, WebP, GIF, AVIF, TIFF, MP4 or WebM file');
      width = (m.orientation >= 5 ? m.height : m.width) || 1;
      height = (m.orientation >= 5 ? m.width : m.height) || 1;
      mime = 'image/' + (m.format === 'jpg' ? 'jpeg' : m.format);
      preview = await sharp(data, { limitInputPixels: 100000000 })
        .rotate()
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
      thumbnail = await sharp(preview)
        .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer();
    }
    const prepared = {
      id,
      name,
      mime,
      width,
      height,
      bytes: data.length,
      data,
      preview,
      thumbnail,
    };
    if (prepareOnly) return prepared;
    return this.commitAsset(prepared);
  }
  commitAsset(a) {
    const file = path.join(this.root, 'assets', a.id);
    durableWrite(file + '.original', a.data);
    if (a.preview) {
      durableWrite(file + '.preview', a.preview);
      durableWrite(file + '.thumb', a.thumbnail);
    }
    this.db
      .prepare('INSERT OR IGNORE INTO assets VALUES(?,?,?,?,?,?)')
      .run(a.id, a.name, a.mime, a.width, a.height, a.bytes);
    return {
      id: a.id,
      name: a.name,
      mime: a.mime,
      width: a.width,
      height: a.height,
      bytes: a.bytes,
    };
  }
  asset({ id, variant = 'preview' }) {
    if (!/^[a-f0-9]{64}$/.test(id) || !['original', 'preview', 'thumb'].includes(variant))
      throw Error('Invalid asset');
    const a = this.db.prepare('SELECT * FROM assets WHERE id=?').get(id);
    if (!a) throw Error('Asset not found');
    const suffix = a.mime.startsWith('video/') ? 'original' : variant;
    return {
      ...a,
      file: path.join(this.root, 'assets', id + '.' + suffix),
      contentType: suffix === 'original' ? a.mime : 'image/webp',
    };
  }
  async readAsset({ id, variant = 'preview' }) {
    if (!variant.startsWith('tile-')) return this.asset({ id, variant });
    const match = /^tile-(\d+)-(\d+)-(\d+)-(\d+)$/.exec(variant);
    if (!match) throw Error('Invalid image tile');
    const [cols, rows, x, y] = match.slice(1).map(Number);
    const validGrid = (n) => n >= 1 && n <= 256 && (n & (n - 1)) === 0;
    if (!validGrid(cols) || !validGrid(rows) || x >= cols || y >= rows)
      throw Error('Invalid image tile');
    const original = this.asset({ id, variant: 'original' });
    if (!original.mime.startsWith('image/')) throw Error('Invalid image tile');
    const file = path.join(this.root, 'assets', `${id}.${variant}`);
    if (!fs.existsSync(file)) {
      // Crop the original before resizing. Decode is off the renderer thread,
      // requests are concurrency-limited, and each GPU tile is at most 512px.
      const left = Math.min(original.width - 1, Math.floor((x * original.width) / cols));
      const top = Math.min(original.height - 1, Math.floor((y * original.height) / rows));
      const right = Math.max(left + 1, Math.floor(((x + 1) * original.width) / cols));
      const bottom = Math.max(top + 1, Math.floor(((y + 1) * original.height) / rows));
      const bytes = await sharp(original.file, { limitInputPixels: 100000000, animated: false })
        .rotate()
        .extract({ left, top, width: right - left, height: bottom - top })
        .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      durableWrite(file, bytes);
    }
    return { ...original, file, contentType: 'image/png' };
  }
  async exportBoard({ id }) {
    const d = this.loadBoard({ id }),
      ids = [
        ...new Set(
          [
            iconAssetId(d.board.icon),
            ...d.objects.flatMap((o) => [o.assetId, o.linkIconId]),
          ].filter(Boolean),
        ),
      ],
      assets = ids.map((id) => this.db.prepare('SELECT * FROM assets WHERE id=?').get(id));
    if (assets.reduce((n, a) => n + a.bytes, 0) > MAX_PACKAGE)
      throw Error('Portable exports are limited to 512 MB in this version');
    const files = {
      'manifest.json': strToU8(
        JSON.stringify({
          format: 'terra-board',
          version: 1,
          name: d.board.name,
          icon: d.board.icon,
          color: d.board.color,
          iconShape: d.board.iconShape,
          showInitial: d.board.showInitial,
          objects: d.objects,
          camera: d.camera,
          assets,
        }),
      ),
    };
    for (const a of assets)
      files['assets/' + a.id] = [
        new Uint8Array(fs.readFileSync(this.asset({ id: a.id, variant: 'original' }).file)),
        { level: 0 },
      ];
    return zipSync(files, { level: 1 });
  }
  async importBoard({ bytes }) {
    const data = new Uint8Array(bytes);
    if (data.byteLength > MAX_PACKAGE + 32 * 1024 * 1024)
      throw Error('Portable board is too large');
    let total = 0,
      count = 0;
    const entries = unzipSync(data, {
      filter: (f) => {
        total += f.originalSize;
        count++;
        if (
          total > MAX_PACKAGE + 32 * 1024 * 1024 ||
          count > 10001 ||
          !(f.name === 'manifest.json' || /^assets\/[a-f0-9]{64}$/.test(f.name))
        )
          throw Error('Invalid portable board contents');
        return true;
      },
    });
    if (!entries['manifest.json'] || entries['manifest.json'].length > 32 * 1024 * 1024)
      throw Error('Invalid board manifest');
    const m = JSON.parse(strFromU8(entries['manifest.json']));
    if (
      (m.format !== 'terra-board' && m.format !== 'local-canvas') ||
      m.version !== 1 ||
      !Array.isArray(m.objects) ||
      m.objects.length > 100000 ||
      !Array.isArray(m.assets)
    )
      throw Error('Unsupported board format');
    nameValue(m.name);
    cameraValue(m.camera);
    if (
      !validIcon(m.icon || 'lightbulb') ||
      !['blue', 'green', 'purple', 'orange', 'rose', 'gray', 'yellow'].includes(m.color || 'blue')
    )
      throw Error('Invalid board metadata');
    const objects = m.objects.map(objectValue),
      assetIds = new Set();
    for (const a of m.assets) {
      if (
        !/^[a-f0-9]{64}$/.test(a.id) ||
        !entries['assets/' + a.id] ||
        createHash('sha256')
          .update(entries['assets/' + a.id])
          .digest('hex') !== a.id
      )
        throw Error('Missing or damaged media');
      assetIds.add(a.id);
    }
    if (
      (iconAssetId(m.icon) && !assetIds.has(iconAssetId(m.icon))) ||
      objects.some(
        (o) =>
          (o.assetId && !assetIds.has(o.assetId)) || (o.linkIconId && !assetIds.has(o.linkIconId)),
      )
    )
      throw Error('Missing media in portable board');
    if (new Set(objects.map((o) => o.id)).size !== objects.length)
      throw Error('Duplicate object identifiers');
    const prepared = [];
    for (const a of m.assets)
      prepared.push(
        await this.importAsset({ bytes: entries['assets/' + a.id], name: a.name }, true),
      );
    return this.transaction(() => {
      for (const a of prepared) if (a.data) this.commitAsset(a);
      const b = this.createBoard({ name: m.name });
      this.updateBoard({
        id: b.id,
        patch: {
          icon: m.icon || 'lightbulb',
          color: m.color || 'blue',
          iconShape: m.iconShape || 'rounded',
          showInitial: m.showInitial ?? true,
        },
      });
      this.patchBoardInner(b.id, objects, m.camera);
      return this.board(b.id);
    });
  }
  patchBoardInner(id, objects, camera) {
    const insert = this.db.prepare('INSERT INTO objects VALUES(?,?,?)');
    for (const o of objects) insert.run(id, o.id, JSON.stringify(o));
    this.db.prepare('UPDATE boards SET camera=? WHERE id=?').run(JSON.stringify(camera), id);
  }
}
module.exports = { Store, objectValue, cameraValue };
