const { createSync } = require('./store-sync.cjs');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const sharp = require('sharp');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');
const { attachmentMime } = require('./document-assets.cjs');

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
const searchText = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
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
  'document',
  'link',
  'arrow',
  'highlight',
  'list',
  'paper',
  'html',
  'browser',
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
// Inline text formatting (src/canvas/rich-text.ts). Malformed ranges are
// dropped and clamped rather than rejecting the object, so an external text
// edit that shortens the string never makes a board unsavable.
const markFlags = ['bold', 'italic', 'underline', 'strike', 'code', 'spoiler'];
const markFonts = ['serif', 'mono', 'hand', 'condensed'];
function marksValue(value, length) {
  if (!Array.isArray(value)) return undefined;
  const marks = [];
  let at = 0;
  for (const m of value.slice(0, 5000)) {
    if (!m || !Number.isInteger(m.start) || !Number.isInteger(m.end)) continue;
    const start = Math.max(at, m.start),
      end = Math.min(length, m.end);
    if (end <= start) continue;
    const mark = { start, end };
    for (const flag of markFlags) if (m[flag] === true) mark[flag] = true;
    for (const key of ['color', 'highlight'])
      if (typeof m[key] === 'string' && /^#[0-9a-f]{6}$/i.test(m[key])) mark[key] = m[key];
    if (markFonts.includes(m.font)) mark.font = m.font;
    if (typeof m.size === 'number' && m.size >= 0.5 && m.size <= 3 && m.size !== 1)
      mark.size = m.size;
    if (Object.keys(mark).length > 2) {
      marks.push(mark);
      at = end;
    }
  }
  return marks.length ? marks : undefined;
}
const number = (value, min = -1e9, max = 1e9) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
function cameraValue(c) {
  if (!c || !number(c.x) || !number(c.y) || !number(c.zoom, 0.01, 16))
    throw Error('Invalid camera');
  return { x: c.x, y: c.y, zoom: c.zoom };
}
function backgroundAppearanceValue(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid background appearance');
  const result = {
    blur: 0,
    brightness: 100,
    saturation: 100,
    sharpness: 0,
    filter: 'none',
    ...value,
  };
  for (const [key, max] of [
    ['blur', 40],
    ['brightness', 200],
    ['saturation', 200],
    ['sharpness', 100],
  ])
    if (!number(result[key], 0, max)) throw Error('Invalid background ' + key);
  if (!['none', 'sepia', 'mono', 'warm', 'cool'].includes(result.filter))
    throw Error('Invalid background filter');
  return {
    blur: result.blur,
    brightness: result.brightness,
    saturation: result.saturation,
    sharpness: result.sharpness,
    filter: result.filter,
  };
}
function pdfComposerValue(value) {
  if (!value || !Array.isArray(value.sources) || !Array.isArray(value.columns))
    throw Error('Invalid PDF composer sources or columns');
  if (value.sources.length > 500 || value.columns.length > 500)
    throw Error('PDF composers are limited to 500 sources and 500 columns');
  const ids = new Set();
  const claim = (value) => {
    const id = idValue(value);
    if (ids.has(id)) throw Error('PDF composer identifiers must be unique');
    ids.add(id);
    return id;
  };
  const validName = (name) => typeof name === 'string' && name.length <= 100000;
  const sources = value.sources.map((source) => {
    if (
      !source ||
      typeof source.assetId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(source.assetId) ||
      !validName(source.name) ||
      !['pdf', 'image'].includes(source.kind) ||
      !Number.isInteger(source.pageCount) ||
      source.pageCount < 1 ||
      source.pageCount > 500
    )
      throw Error('Invalid PDF composer source');
    return {
      id: claim(source.id),
      assetId: source.assetId,
      name: source.name,
      kind: source.kind,
      pageCount: source.pageCount,
    };
  });
  const byId = new Map(sources.map((source) => [source.id, source]));
  let count = 0;
  const columns = value.columns.map((column) => {
    if (!column || !validName(column.name) || !Array.isArray(column.pages))
      throw Error('Invalid PDF composer column');
    const id = claim(column.id);
    count += column.pages.length;
    if (count > 500) throw Error('PDF composers are limited to 500 page references');
    const rows = new Set();
    const pages = column.pages.map((page, index) => {
      if (!page) throw Error('Invalid PDF composer page');
      const row = page.row ?? index;
      if (!Number.isInteger(row) || row < 0 || row >= 1000 || rows.has(row))
        throw Error('Invalid or duplicate PDF page slot');
      rows.add(row);
      const id = claim(page.id),
        source = byId.get(page.sourceId);
      if (
        !source ||
        !Number.isInteger(page.pageIndex) ||
        page.pageIndex < 0 ||
        page.pageIndex >= source.pageCount
      )
        throw Error('PDF composer page must reference an existing source page');
      if (!Number.isSafeInteger(page.rotation) || page.rotation % 90 !== 0)
        throw Error('Invalid PDF composer page rotation');
      return {
        id,
        sourceId: source.id,
        pageIndex: page.pageIndex,
        rotation: page.rotation,
        ...(column.pages.some((p) => p.row !== undefined) ? { row } : {}),
      };
    });
    const slotCount = column.slotCount;
    if (
      slotCount !== undefined &&
      (!Number.isInteger(slotCount) ||
        slotCount < 0 ||
        slotCount > 1000 ||
        [...rows].some((row) => row >= slotCount))
    )
      throw Error('Invalid PDF column slot count');
    pages.sort(
      (a, b) =>
        (a.row ?? column.pages.findIndex((p) => p.id === a.id)) -
        (b.row ?? column.pages.findIndex((p) => p.id === b.id)),
    );
    return { id, name: column.name, pages, ...(slotCount !== undefined ? { slotCount } : {}) };
  });
  if (value.view !== undefined && !['stacked', 'full'].includes(value.view))
    throw Error('Invalid PDF view');
  if (
    value.zoom !== undefined &&
    (!Number.isFinite(value.zoom) || value.zoom < 0.75 || value.zoom > 3)
  )
    throw Error('Invalid PDF zoom');
  return {
    sources,
    columns,
    ...(value.view !== undefined ? { view: value.view } : {}),
    ...(value.zoom !== undefined ? { zoom: value.zoom } : {}),
  };
}
const objectAssetIds = (object) =>
  [
    object.assetId,
    object.linkIconId,
    object.documentPreviewId,
    ...(object.pdfComposer?.sources.map((source) => source.assetId) || []),
  ].filter(Boolean);
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
  if (o.frameLink !== undefined) {
    if (
      o.type !== 'frame' ||
      !o.frameLink ||
      o.gallery !== undefined ||
      o.pdfComposer !== undefined
    )
      throw Error('Invalid frame link');
    result.frameLink = {
      boardId: idValue(o.frameLink.boardId),
      frameId: idValue(o.frameLink.frameId),
    };
  }
  if (o.pdfComposer !== undefined) {
    if (o.type !== 'frame' || o.gallery !== undefined)
      throw Error('PDF composers must be non-gallery frames');
    result.pdfComposer = pdfComposerValue(o.pdfComposer);
  }
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
  if (o.type === 'highlight') {
    const h = o.highlight;
    if (
      !h ||
      !Array.isArray(h.points) ||
      h.points.length < 2 ||
      h.points.length > 2000 ||
      !h.points.every((p) => p && number(p.x, 0, 1) && number(p.y, 0, 1)) ||
      !number(h.size, 0.25, 10000)
    )
      throw Error('Invalid highlight');
    result.highlight = { points: h.points.map((p) => ({ x: p.x, y: p.y })), size: h.size };
  }
  if (o.text !== undefined) {
    if (typeof o.text !== 'string' || o.text.length > 100000) throw Error('Invalid text');
    result.text = o.text;
    const textMarks = marksValue(o.textMarks, o.text.length);
    if (textMarks) result.textMarks = textMarks;
  }
  if (o.type === 'list') {
    if (
      !Array.isArray(o.items) ||
      o.items.length > 1000 ||
      !o.items.every(
        (item) =>
          item &&
          typeof item.id === 'string' &&
          /^[\w-]{1,100}$/.test(item.id) &&
          typeof item.text === 'string' &&
          item.text.length <= 10000 &&
          typeof item.checked === 'boolean',
      ) ||
      new Set(o.items.map((item) => item.id)).size !== o.items.length
    )
      throw Error('Invalid list items');
    result.items = o.items.map(({ id, text, checked, marks }) => {
      const item = { id, text, checked };
      const value = marksValue(marks, text.length);
      if (value) item.marks = value;
      return item;
    });
    if (o.listScale !== undefined) {
      if (!number(o.listScale, 1e-6, 1e6)) throw Error('Invalid list scale');
      result.listScale = o.listScale;
    }
  }
  if (o.imageTitle !== undefined) {
    if (o.type !== 'image' || typeof o.imageTitle !== 'string' || o.imageTitle.length > 100000)
      throw Error('Invalid image title');
    result.imageTitle = o.imageTitle;
  }
  for (const [key, limit] of [
    ['documentTitle', 100000],
    ['documentMime', 200],
    ['documentExcerpt', 10000],
  ]) {
    if (o[key] !== undefined) {
      if (
        (o.type !== 'document' && !(o.type === 'paper' && key === 'documentTitle')) ||
        typeof o[key] !== 'string' ||
        o[key].length > limit
      )
        throw Error('Invalid document metadata');
      result[key] = o[key];
    }
  }
  const title =
    o.type === 'image'
      ? result.imageTitle
      : o.type === 'document'
        ? result.documentTitle
        : undefined;
  if (title !== undefined) {
    const titleMarks = marksValue(o.titleMarks, title.length);
    if (titleMarks) result.titleMarks = titleMarks;
  }
  for (const [key, min, max] of [
    ['documentBytes', 0, 256 * 1024 * 1024],
    ['documentPageCount', 1, 100000],
  ]) {
    if (o[key] !== undefined) {
      if (o.type !== 'document' || !Number.isInteger(o[key]) || !number(o[key], min, max))
        throw Error('Invalid document metadata');
      result[key] = o[key];
    }
  }
  if (o.documentPreviewId !== undefined) {
    if (
      o.type !== 'document' ||
      typeof o.documentPreviewId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(o.documentPreviewId)
    )
      throw Error('Invalid document preview');
    result.documentPreviewId = o.documentPreviewId;
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
  for (const key of [
    'centerX',
    'centerY',
    'textBox',
    'bold',
    'strikethrough',
    'locked',
    'spoiler',
  ]) {
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
  if (o.type === 'image' || o.type === 'video' || o.type === 'document') {
    if (!o.assetId) throw Error('Missing asset');
    if (o.type === 'document' && !/^[a-f0-9]{64}$/.test(o.assetId))
      throw Error('Invalid document asset');
  }
  if (o.html !== undefined) {
    if (o.type !== 'html' || typeof o.html !== 'string' || o.html.length > 1000000)
      throw Error('Invalid HTML source');
    result.html = o.html;
  }
  if (o.snapshotKey !== undefined) {
    if (
      (o.type !== 'html' && o.type !== 'browser') ||
      typeof o.snapshotKey !== 'string' ||
      !/^[\w-]{1,100}$/.test(o.snapshotKey)
    )
      throw Error('Invalid HTML snapshot');
    result.snapshotKey = o.snapshotKey;
  }
  if (o.type === 'link' || o.type === 'browser') {
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
    // SQLite's built-in lower() only folds ASCII; board content can be multilingual.
    this.db.function('search_contains', { deterministic: true }, (value, query) =>
      Number(searchText(value).toLowerCase().includes(query)),
    );
    if (this.db.prepare('PRAGMA user_version').get().user_version > 2) {
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
   CREATE TABLE IF NOT EXISTS object_revisions(boardId TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(boardId,id));
   CREATE INDEX IF NOT EXISTS object_revisions_age ON object_revisions(boardId,revision);
   CREATE TABLE IF NOT EXISTS merge_floors(boardId TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,revision INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=2;`);
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
    if (
      !this.db
        .prepare('PRAGMA table_info(boards)')
        .all()
        .some((column) => column.name === 'backgroundAssetId')
    )
      this.db.exec('ALTER TABLE boards ADD COLUMN backgroundAssetId TEXT DEFAULT NULL');
    if (
      !this.db
        .prepare('PRAGMA table_info(boards)')
        .all()
        .some((column) => column.name === 'backgroundAppearance')
    )
      this.db.exec("ALTER TABLE boards ADD COLUMN backgroundAppearance TEXT NOT NULL DEFAULT '{}'");
    this.sync = createSync(this, {
      idValue,
      nameValue,
      validIcon,
      iconAssetId,
      backgroundAppearanceValue,
      number,
      objectValue,
    });
    const backup = path.join(root, 'backups', new Date().toISOString().slice(0, 10) + '.sqlite');
    if (!fs.existsSync(backup) && this.db.prepare('SELECT count(*) AS n FROM boards').get().n) {
      try {
        this.db.exec("VACUUM INTO '" + backup.replace(/'/g, "''") + "'");
      } catch (e) {
        this.backupError = e.message;
      }
    }
  }
  syncStatus() {
    return this.sync.status();
  }
  syncEnable(args) {
    return this.sync.enable(args);
  }
  syncDisable() {
    return this.sync.disable();
  }
  syncIdentity(args) {
    return this.sync.identity(args);
  }
  syncLibrary(args) {
    return this.sync.library(args);
  }
  syncOwned(args) {
    return this.sync.owned(args);
  }
  syncKeepLocal(args) {
    return this.sync.keepLocal(args);
  }
  syncReconcile(args) {
    return this.sync.reconcile(args);
  }
  syncCursor(args) {
    return this.sync.cursor(args);
  }
  syncRename(args) {
    return this.sync.rename(args);
  }
  syncProfile() {
    return this.sync.profile();
  }
  syncSetProfile(args) {
    return this.sync.setProfile(args);
  }
  syncTake(args) {
    return this.sync.take(args);
  }
  syncAck(args) {
    return this.sync.ack(args);
  }
  syncMissingAssets(args) {
    return this.sync.missingAssets(args);
  }
  syncApply(args) {
    return this.sync.apply(args);
  }
  syncImportAsset(args) {
    return this.sync.importAsset(args);
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
          'SELECT id,name,icon,color,iconShape,showInitial,backgroundAssetId,backgroundAppearance,folderId,position,trashed,updated FROM boards ORDER BY position',
        )
        .all()
        .map((b) => ({
          ...b,
          backgroundAppearance: backgroundAppearanceValue(JSON.parse(b.backgroundAppearance)),
          trashed: !!b.trashed,
          showInitial: !!b.showInitial,
        })),
      folders: this.db.prepare('SELECT * FROM folders ORDER BY position').all(),
      lastBoard:
        this.db.prepare("SELECT value FROM settings WHERE key='lastBoard'").get()?.value || null,
      backupError: this.backupError || null,
      sharing: this.sync.marks(),
    };
  }
  board(id) {
    const b = this.db.prepare('SELECT * FROM boards WHERE id=?').get(idValue(id));
    if (!b) throw Error('Board not found');
    return {
      ...b,
      backgroundAppearance: backgroundAppearanceValue(JSON.parse(b.backgroundAppearance)),
      trashed: !!b.trashed,
      showInitial: !!b.showInitial,
    };
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
      backgroundAssetId: null,
      backgroundAppearance: backgroundAppearanceValue(),
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
    if (patch.backgroundAppearance !== undefined)
      b.backgroundAppearance = backgroundAppearanceValue(patch.backgroundAppearance);
    if (patch.backgroundAssetId !== undefined) {
      const assetId = patch.backgroundAssetId;
      if (
        assetId !== null &&
        (typeof assetId !== 'string' ||
          !/^[a-f0-9]{64}$/.test(assetId) ||
          !this.db.prepare("SELECT id FROM assets WHERE id=? AND mime LIKE 'image/%'").get(assetId))
      )
        throw Error('Choose a valid image for the board background');
      b.backgroundAssetId = assetId;
    }
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
        'UPDATE boards SET name=?,icon=?,color=?,iconShape=?,showInitial=?,backgroundAssetId=?,backgroundAppearance=?,folderId=?,position=?,trashed=?,updated=? WHERE id=?',
      )
      .run(
        b.name,
        b.icon,
        b.color,
        b.iconShape,
        +b.showInitial,
        b.backgroundAssetId,
        JSON.stringify(b.backgroundAppearance),
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
  searchContent({ query }) {
    if (typeof query !== 'string' || query.length > 200) throw Error('Invalid search query');
    const needle = searchText(query).toLowerCase();
    if (!needle) return { results: [], hasMore: false };
    const rows = this.db
      .prepare(
        `
      SELECT o.boardId, o.id AS objectId,
        json_extract(o.json, '$.type') AS type,
        json_extract(o.json, '$.text') AS text,
        json_extract(o.json, '$.imageTitle') AS imageTitle,
        json_extract(o.json, '$.documentTitle') AS documentTitle,
        json_extract(o.json, '$.documentExcerpt') AS documentExcerpt,
        json_extract(o.json, '$.url') AS url,
        json_extract(o.json, '$.linkDescription') AS linkDescription,
        (SELECT group_concat(json_extract(value, '$.text'), ' ') FROM json_each(o.json, '$.items')) AS listText,
        (SELECT group_concat(json_extract(value, '$.name'), ' ') FROM json_each(o.json, '$.pdfComposer.columns')) AS composerColumns,
        (SELECT group_concat(json_extract(value, '$.name'), ' ') FROM json_each(o.json, '$.pdfComposer.sources')) AS composerSources
      FROM boards b JOIN objects o ON o.boardId = b.id
      WHERE b.trashed = 0 AND (
        search_contains(json_extract(o.json, '$.text'), ?) OR
        search_contains(json_extract(o.json, '$.imageTitle'), ?) OR
        search_contains(json_extract(o.json, '$.documentTitle'), ?) OR
        search_contains(json_extract(o.json, '$.documentExcerpt'), ?) OR
        search_contains(json_extract(o.json, '$.url'), ?) OR
        search_contains(json_extract(o.json, '$.linkDescription'), ?) OR
        EXISTS (SELECT 1 FROM json_each(o.json, '$.items') WHERE search_contains(json_extract(value, '$.text'), ?)) OR
        EXISTS (SELECT 1 FROM json_each(o.json, '$.pdfComposer.columns') WHERE search_contains(json_extract(value, '$.name'), ?)) OR
        EXISTS (SELECT 1 FROM json_each(o.json, '$.pdfComposer.sources') WHERE search_contains(json_extract(value, '$.name'), ?)))
      ORDER BY b.position, b.id, o.id LIMIT 61
    `,
      )
      .all(needle, needle, needle, needle, needle, needle, needle, needle, needle);
    return {
      results: rows.slice(0, 60).map((row) => {
        const text = [
          row.imageTitle,
          row.documentTitle,
          row.text,
          row.documentExcerpt,
          row.url,
          row.linkDescription,
          row.listText,
          row.composerColumns,
          row.composerSources,
        ]
          .map(searchText)
          .find((value) => value.toLowerCase().includes(needle));
        const index = text.toLowerCase().indexOf(needle);
        const start = Math.max(0, index - 55);
        const end = Math.min(text.length, Math.max(start + 260, index + needle.length));
        return {
          boardId: row.boardId,
          objectId: row.objectId,
          type: row.type,
          excerpt: (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : ''),
        };
      }),
      hasMore: rows.length > 60,
    };
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
  patchBoard({
    id,
    revision,
    upserts = [],
    deleted = [],
    camera,
    operationId,
    protectLocked = false,
  }) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw Error('Invalid revision');
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
    const findAsset = this.db.prepare('SELECT id,mime FROM assets WHERE id=?');
    for (const o of objects) {
      if (o.assetId && !findAsset.get(o.assetId)) throw Error('Missing media asset');
      if (o.linkIconId && !findAsset.get(o.linkIconId)) throw Error('Missing site icon');
      if (o.documentPreviewId && !findAsset.get(o.documentPreviewId)?.mime.startsWith('image/'))
        throw Error('Missing document preview image asset');
      for (const source of o.pdfComposer?.sources || [])
        if (!findAsset.get(source.assetId)) throw Error('Missing PDF composer source asset');
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
      if (revision > b.revision) throw Error('Invalid future board revision');
      if (!objects.length && !deleted.length) {
        if (camera) this.saveCamera({ id, camera });
        return { revision: b.revision };
      }
      // Existing libraries have no object history. Start at their current revision;
      // retain deletion tombstones so stale writes cannot resurrect removed objects.
      this.db.prepare('INSERT OR IGNORE INTO merge_floors VALUES(?,?)').run(id, b.revision);
      const floor = this.db
        .prepare('SELECT revision FROM merge_floors WHERE boardId=?')
        .get(id).revision;
      const touched = new Set([...objects.map((o) => o.id), ...deleted]);
      if (protectLocked) {
        const readObject = this.db.prepare('SELECT json FROM objects WHERE boardId=? AND id=?');
        const targets = new Set([...touched, ...objects.map((o) => o.galleryId).filter(Boolean)]);
        const locked = [...targets].filter((oid) => {
          const row = readObject.get(id, oid);
          return row && JSON.parse(row.json).locked;
        });
        if (locked.length)
          throw Error(
            'Objects are locked: ' +
              locked.slice(0, 20).join(', ') +
              '. Hold the lock button in Terra Board for five seconds to unlock.',
          );
      }
      if (revision < floor)
        throw Error('Board revision is too old; read_board again before editing');
      if (revision < b.revision) {
        const changed = this.db.prepare(
          'SELECT revision FROM object_revisions WHERE boardId=? AND id=?',
        );
        const conflicts = [...touched].filter(
          (oid) => (changed.get(id, oid)?.revision ?? 0) > revision,
        );
        if (conflicts.length)
          throw Error(
            'Objects changed since this revision: ' +
              conflicts.slice(0, 20).join(', ') +
              '. Read_board again before editing these objects.',
          );
      }
      const nextRevision = b.revision + 1;
      const write = this.db.prepare(
        'INSERT INTO objects VALUES(?,?,?) ON CONFLICT(boardId,id) DO UPDATE SET json=excluded.json',
      );
      const del = this.db.prepare('DELETE FROM objects WHERE boardId=? AND id=?');
      for (const o of objects) write.run(id, o.id, JSON.stringify(o));
      for (const oid of deleted) del.run(id, oid);
      const track = this.db.prepare(
        'INSERT INTO object_revisions VALUES(?,?,?) ON CONFLICT(boardId,id) DO UPDATE SET revision=excluded.revision',
      );
      for (const oid of touched) track.run(id, oid, nextRevision);
      const keepFrom = Math.max(floor, nextRevision - 500);
      this.db.prepare('UPDATE merge_floors SET revision=? WHERE boardId=?').run(keepFrom, id);
      this.db
        .prepare('DELETE FROM object_revisions WHERE boardId=? AND revision<=?')
        .run(id, keepFrom);
      this.db
        .prepare('UPDATE boards SET revision=revision+1,camera=?,updated=? WHERE id=?')
        .run(camera ? JSON.stringify(camera) : b.camera, Date.now(), id);
      if (operationId) {
        this.db
          .prepare('INSERT INTO operations VALUES(?,?,?,?)')
          .run(id, operationId, nextRevision, signature);
        this.db
          .prepare('DELETE FROM operations WHERE boardId=? AND revision<?')
          .run(id, nextRevision - 500);
      }
      return { revision: nextRevision };
    });
  }
  saveCamera({ id, camera }) {
    this.board(id);
    const value = JSON.stringify(cameraValue(camera));
    this.db.prepare('UPDATE boards SET camera=? WHERE id=? AND camera<>?').run(value, id, value);
    return true;
  }
  duplicateBoard({ id }) {
    return this.transaction(() => {
      const original = this.board(id),
        copy = this.createBoard({
          name: graphemes(original.name).slice(0, 110).join('') + ' copy',
          folderId: original.folderId,
        });
      this.db
        .prepare(
          'UPDATE boards SET icon=?,color=?,iconShape=?,showInitial=?,backgroundAssetId=?,backgroundAppearance=?,camera=? WHERE id=?',
        )
        .run(
          original.icon,
          original.color,
          original.iconShape,
          +original.showInitial,
          original.backgroundAssetId,
          JSON.stringify(original.backgroundAppearance),
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
        backgroundAssetId: original.backgroundAssetId,
        backgroundAppearance: original.backgroundAppearance,
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
  async removeBackground({ id, icon = false }) {
    const asset = this.asset({ id, variant: 'original' });
    if (!asset.mime.startsWith('image/')) throw Error('Choose an image to remove its background.');
    if (typeof icon !== 'boolean') throw Error('Invalid icon option');
    const bytes = await require('./background-removal.cjs').removeBackground(asset.file, icon);
    if (!bytes) {
      const { file, contentType, ...original } = asset;
      return original;
    }
    return this.importAsset({ bytes, name: asset.name.replace(/\.[^.]+$/, '') + ' - cutout.png' });
  }
  async importAsset({ bytes, name }, prepareOnly = false) {
    name = String(name || 'image.png').slice(0, 240);
    let data = Buffer.from(bytes);
    if (data.length > 256 * 1024 * 1024)
      throw Error('Files must be no larger than 256 MB in this version');
    const documentMime = attachmentMime(name, data);
    if (!documentMime && data.length >= 4 && data.readUInt32LE(0) === 0x00010000) {
      data = await require('./icon-image.cjs').iconPng(data);
      name = name.replace(/\.[^.]+$/, '') + '.png';
    }
    const id = createHash('sha256').update(data).digest('hex');
    const existing = this.db.prepare('SELECT * FROM assets WHERE id=?').get(id);
    // A file may first arrive as an opaque document and later as an image or
    // video. Validate and prepare that media before promoting its shared row.
    if (existing && (documentMime || /^(image|video)\//.test(existing.mime)))
      return {
        ...existing,
        name,
        ...(documentMime ? { mime: documentMime, width: 0, height: 0 } : {}),
      };
    let mime, width, height, preview, thumbnail;
    const ext = path.extname(name).toLowerCase();
    if (documentMime) {
      mime = documentMime;
      width = 0;
      height = 0;
    } else if (['.mp4', '.webm'].includes(ext)) {
      const valid =
        ext === '.mp4'
          ? data.subarray(4, 8).toString() === 'ftyp'
          : data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3;
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
      .prepare(
        `INSERT INTO assets VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,mime=excluded.mime,
          width=excluded.width,height=excluded.height
        WHERE (excluded.mime LIKE 'image/%' OR excluded.mime LIKE 'video/%')
          AND assets.mime NOT LIKE 'image/%' AND assets.mime NOT LIKE 'video/%'`,
      )
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
    const suffix = a.mime.startsWith('image/') ? variant : 'original';
    return {
      ...a,
      file: path.join(this.root, 'assets', id + '.' + suffix),
      contentType: suffix === 'original' ? a.mime : 'image/webp',
    };
  }
  async readAsset({ id, variant = 'preview' }) {
    // Lossless, orientation-correct fallback for formats Chromium cannot decode
    // directly (notably TIFF). Never substitute the small WebP preview in exports.
    if (variant === 'export') {
      const original = this.asset({ id, variant: 'original' });
      if (!original.mime.startsWith('image/')) throw Error('Only images can be exported as PNG');
      const file = path.join(this.root, 'assets', `${id}.export.png`);
      if (!fs.existsSync(file)) {
        const bytes = await sharp(original.file, { limitInputPixels: 100000000 })
          .rotate()
          .png()
          .toBuffer();
        durableWrite(file, bytes);
      }
      return { ...original, file, contentType: 'image/png' };
    }
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
            d.board.backgroundAssetId,
            ...d.objects.flatMap(objectAssetIds),
          ].filter(Boolean),
        ),
      ],
      assets = ids.map((id) => this.db.prepare('SELECT * FROM assets WHERE id=?').get(id));
    if (assets.some((asset) => !asset)) throw Error('Missing media asset in board export');
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
          backgroundAssetId: d.board.backgroundAssetId,
          backgroundAppearance: d.board.backgroundAppearance,
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
      (m.backgroundAssetId != null && !assetIds.has(m.backgroundAssetId)) ||
      objects.some((o) => objectAssetIds(o).some((id) => !assetIds.has(id)))
    )
      throw Error('Missing media in portable board');
    if (new Set(objects.map((o) => o.id)).size !== objects.length)
      throw Error('Duplicate object identifiers');
    const prepared = [];
    for (const a of m.assets)
      prepared.push(
        await this.importAsset({ bytes: entries['assets/' + a.id], name: a.name }, true),
      );
    const preparedById = new Map(prepared.map((a) => [a.id, a]));
    for (const o of objects)
      if (o.documentPreviewId && !preparedById.get(o.documentPreviewId)?.mime.startsWith('image/'))
        throw Error('Missing document preview image asset');
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
          backgroundAssetId: m.backgroundAssetId ?? null,
          backgroundAppearance: m.backgroundAppearance ?? {},
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
