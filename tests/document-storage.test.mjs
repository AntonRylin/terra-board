import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { z } from 'zod';
import sharp from 'sharp';
import { clipboardObjects } from '../src/canvas/content.ts';
const require = createRequire(import.meta.url);
const { Store, objectValue } = require('../electron/store.cjs');
const { tools } = require('../electron/mcp-tools.cjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const document = (assetId, patch = {}) => ({
  id: 'document',
  type: 'document',
  x: 20,
  y: -30,
  width: 320,
  height: 420,
  z: 1,
  assetId,
  text: 'original-report.pdf',
  documentTitle: 'Research outline',
  documentMime: 'application/pdf',
  documentBytes: 19,
  documentExcerpt: 'A searchable document excerpt',
  documentPageCount: 2,
  ...patch,
});
function fixture() {
  mkdirSync(resolve('.local-test'), { recursive: true });
  const root = mkdtempSync(resolve('.local-test/documents-'));
  return { root, store: new Store(root) };
}
const pdf = Buffer.from('%PDF-1.7\noriginal\n%%EOF\n');
const docx = Buffer.from(
  zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'word/document.xml': strToU8('<document>Original Word text</document>'),
  }),
);
const xlsx = Buffer.from(
  zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8('<workbook/>'),
  }),
);

test('document and generic uploads preserve exact original bytes, MIME and empty files', async () => {
  const { root, store } = fixture();
  try {
    const fixtures = [
      ['Report.PDF', pdf, 'application/pdf'],
      [
        'Word export.docx',
        docx,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
      ['Workbook.xlsx', xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['Legacy.doc', Buffer.from('legacy Word bytes'), 'application/msword'],
      ['Legacy.xls', Buffer.from('legacy Excel bytes'), 'application/vnd.ms-excel'],
      [
        'Google export.odt',
        Buffer.from('exported document bytes'),
        'application/vnd.oasis.opendocument.text',
      ],
      [
        'Google shortcut.gdoc',
        Buffer.from('{"url":"https://docs.google.com/document/d/local"}'),
        'application/vnd.google-apps.document',
      ],
      ['Notes.txt', Buffer.from('\ufeffПривет — 日本\r\n'), 'text/plain'],
      ['Empty.txt', Buffer.alloc(0), 'text/plain'],
      ['Table.csv', Buffer.from('name,value\r\nA,1\r\n'), 'text/csv'],
      ['Unknown.blob', Buffer.from([0, 1, 255, 27, 0, 78]), 'application/octet-stream'],
    ];
    for (const [name, bytes, mime] of fixtures) {
      const asset = await store.importAsset({ bytes, name });
      assert.equal(asset.name, name);
      assert.equal(asset.id, hash(bytes));
      assert.equal(asset.mime, mime);
      assert.equal(asset.bytes, bytes.length);
      assert.deepEqual([asset.width, asset.height], [0, 0]);
      for (const variant of ['original', 'preview', 'thumb']) {
        const original = await store.readAsset({ id: asset.id, variant });
        assert.equal(original.contentType, mime, 'attachments never pretend to be WebP images');
        assert.deepEqual(readFileSync(original.file), bytes);
      }
      await assert.rejects(store.readAsset({ id: asset.id, variant: 'export' }), /images/i);
      await assert.rejects(
        store.readAsset({ id: asset.id, variant: 'tile-1-1-0-0' }),
        /image tile/i,
      );
    }
    assert.ok(readdirSync(join(root, 'assets')).every((name) => name.endsWith('.original')));
  } finally {
    store.close();
  }
});

test('deduplicated imports return each selected filename while retaining immutable bytes', async () => {
  const { store } = fixture();
  try {
    const first = await store.importAsset({ bytes: pdf, name: 'first.pdf' });
    const second = await store.importAsset({ bytes: pdf, name: 'second.pdf' });
    assert.equal(first.id, second.id);
    assert.equal(first.name, 'first.pdf');
    assert.equal(second.name, 'second.pdf');
    assert.deepEqual(readFileSync(store.asset({ id: first.id, variant: 'original' }).file), pdf);
    const unknown = await store.importAsset({ bytes: Buffer.alloc(0), name: 'first.blob' });
    const emptyText = await store.importAsset({ bytes: Buffer.alloc(0), name: 'second.txt' });
    assert.equal(unknown.id, emptyText.id);
    assert.equal(emptyText.name, 'second.txt');
    assert.equal(
      emptyText.mime,
      'text/plain',
      'each import retains its filename-derived document type',
    );
  } finally {
    store.close();
  }
});

test('document-to-image deduplication promotes canonical previews without changing document objects or original bytes', async () => {
  const source = fixture(),
    target = fixture(),
    fresh = fixture();
  try {
    const bytes = await sharp({
      create: { width: 17, height: 11, channels: 3, background: '#ddeeff' },
    })
      .png()
      .toBuffer();
    const raw = await source.store.importAsset({ bytes, name: 'raw.txt' });
    const originalFile = source.store.asset({ id: raw.id, variant: 'original' }).file;
    const object = {
      id: 'raw-document',
      type: 'document',
      assetId: raw.id,
      text: 'raw.txt',
      documentTitle: 'Raw attachment',
      documentMime: 'text/plain',
      documentBytes: bytes.length,
      x: 20,
      y: 30,
      width: 320,
      height: 400,
      z: 1,
    };
    const board = source.store.createBoard({ name: 'Shared bytes' });
    source.store.patchBoard({ id: board.id, revision: 0, upserts: [object] });
    const image = await source.store.importAsset({ bytes, name: 'photo.png' });
    assert.equal(image.id, raw.id);
    assert.equal(image.mime, 'image/png');
    assert.deepEqual([image.width, image.height], [17, 11]);
    assert.deepEqual(source.store.loadBoard({ id: board.id }).objects, [object]);
    assert.deepEqual(readFileSync(originalFile), bytes);
    const picture = {
      id: 'picture',
      type: 'image',
      assetId: image.id,
      text: 'photo.png',
      x: 400,
      y: 30,
      width: 170,
      height: 110,
      z: 2,
    };
    source.store.patchBoard({ id: board.id, revision: 1, upserts: [picture] });
    const exported = await source.store.exportBoard({ id: board.id });
    const entries = unzipSync(exported);
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    assert.equal(manifest.assets.length, 1);
    assert.equal(manifest.assets[0].name, 'photo.png');
    assert.equal(manifest.assets[0].mime, 'image/png');
    assert.deepEqual(Buffer.from(entries['assets/' + raw.id]), bytes);
    await target.store.importAsset({ bytes, name: 'existing-document.txt' });
    for (const store of [source.store, target.store, fresh.store]) {
      const id =
        store === source.store ? board.id : (await store.importBoard({ bytes: exported })).id;
      const objects = store.loadBoard({ id }).objects;
      assert.deepEqual(
        objects.find((o) => o.id === object.id),
        object,
      );
      assert.deepEqual(
        objects.find((o) => o.id === picture.id),
        picture,
      );
      const canonical = store.asset({ id: raw.id, variant: 'original' });
      assert.equal(canonical.mime, 'image/png');
      assert.equal(canonical.name, 'photo.png');
      assert.deepEqual([canonical.width, canonical.height], [17, 11]);
      assert.deepEqual(readFileSync(canonical.file), bytes);
      for (const variant of ['preview', 'thumb', 'export']) {
        const asset = await store.readAsset({ id: raw.id, variant });
        const metadata = await sharp(asset.file).metadata();
        assert.deepEqual([metadata.width, metadata.height], [17, 11]);
        assert.equal(asset.contentType, variant === 'export' ? 'image/png' : 'image/webp');
      }
    }
  } finally {
    source.store.close();
    target.store.close();
    fresh.store.close();
  }
});

test('image-to-document deduplication retains canonical image dimensions and previews', async () => {
  const { store } = fixture();
  try {
    const bytes = await sharp({
      create: { width: 13, height: 9, channels: 4, background: '#aabbcc88' },
    })
      .png()
      .toBuffer();
    const image = await store.importAsset({ bytes, name: 'original.png' });
    const preview = readFileSync(store.asset({ id: image.id }).file);
    const document = await store.importAsset({ bytes, name: 'attachment.txt' });
    assert.equal(document.id, image.id);
    assert.equal(document.name, 'attachment.txt');
    assert.equal(document.mime, 'text/plain');
    assert.deepEqual([document.width, document.height], [0, 0]);
    const canonical = store.asset({ id: image.id, variant: 'original' });
    assert.equal(canonical.name, 'original.png');
    assert.equal(canonical.mime, 'image/png');
    assert.deepEqual([canonical.width, canonical.height], [13, 9]);
    assert.deepEqual(readFileSync(canonical.file), bytes);
    assert.deepEqual(readFileSync(store.asset({ id: image.id }).file), preview);
  } finally {
    store.close();
  }
});

test('invalid media reimports cannot promote an existing document or alter its bytes', async () => {
  const { root, store } = fixture();
  try {
    const bytes = Buffer.from('This is plain text, not an image.');
    const original = await store.importAsset({ bytes, name: 'original.txt' });
    await assert.rejects(store.importAsset({ bytes, name: 'invalid.png' }), /image|format/i);
    const unchanged = store.asset({ id: original.id, variant: 'original' });
    assert.equal(unchanged.name, 'original.txt');
    assert.equal(unchanged.mime, 'text/plain');
    assert.deepEqual(readFileSync(unchanged.file), bytes);
    assert.deepEqual(readdirSync(join(root, 'assets')), [original.id + '.original']);
  } finally {
    store.close();
  }
});

test('document clipboard and saved schema retain independent titles and bounded metadata', () => {
  const original = document('a'.repeat(64), { documentPreviewId: 'b'.repeat(64) });
  assert.deepEqual(clipboardObjects([original]), [original]);
  assert.deepEqual(objectValue(original), original);
  for (const patch of [
    { assetId: undefined },
    { assetId: 'invalid-id' },
    { documentTitle: null },
    { documentTitle: 'a'.repeat(100001) },
    { documentMime: 5 },
    { documentMime: 'a'.repeat(201) },
    { documentBytes: -1 },
    { documentBytes: 1.5 },
    { documentBytes: 256 * 1024 * 1024 + 1 },
    { documentPreviewId: 'not-an-image-hash' },
    { documentPreviewId: null },
    { documentExcerpt: 'a'.repeat(10001) },
    { documentExcerpt: false },
    { documentPageCount: 0 },
    { documentPageCount: 1.5 },
    { documentPageCount: 100001 },
    { type: 'rect' },
  ]) {
    assert.throws(() => clipboardObjects([{ ...original, ...patch }]), /document|asset|media/i);
    assert.throws(() => objectValue({ ...original, ...patch }), /document|asset|media/i);
  }
  const cleared = { ...original, documentTitle: '', documentBytes: 0, documentExcerpt: '' };
  assert.deepEqual(clipboardObjects([cleared]), [cleared]);
  assert.deepEqual(objectValue(cleared), cleared);
});

test('documents and image previews survive save/reopen and portable transfer to another library', async () => {
  const source = fixture();
  const target = fixture();
  let store = source.store;
  try {
    const asset = await store.importAsset({ bytes: pdf, name: 'first.pdf' });
    const previewBytes = await sharp({
      create: { width: 8, height: 10, channels: 3, background: '#ddeeff' },
    })
      .png()
      .toBuffer();
    const preview = await store.importAsset({ bytes: previewBytes, name: 'Page preview.png' });
    const object = document(asset.id, { documentBytes: pdf.length, documentPreviewId: preview.id });
    const board = store.createBoard({ name: 'Documents' });
    store.patchBoard({ id: board.id, revision: 0, upserts: [object] });
    store.close();
    store = new Store(source.root);
    assert.deepEqual(store.loadBoard({ id: board.id }).objects, [object]);
    const exported = await store.exportBoard({ id: board.id });
    const entries = unzipSync(exported);
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    assert.deepEqual(manifest.assets.map((a) => a.id).sort(), [asset.id, preview.id].sort());
    assert.deepEqual(Buffer.from(entries['assets/' + asset.id]), pdf);
    assert.deepEqual(Buffer.from(entries['assets/' + preview.id]), previewBytes);
    const imported = await target.store.importBoard({ bytes: exported });
    assert.deepEqual(target.store.loadBoard({ id: imported.id }).objects, [object]);
    assert.deepEqual(
      readFileSync(target.store.asset({ id: asset.id, variant: 'original' }).file),
      pdf,
    );
    assert.equal(target.store.asset({ id: preview.id }).contentType, 'image/webp');
    const copy = target.store.duplicateBoard({ id: imported.id });
    assert.deepEqual(target.store.loadBoard({ id: copy.id }).objects, [object]);
    const invalidPreview = {
      ...entries,
      'manifest.json': strToU8(
        JSON.stringify({
          ...manifest,
          objects: [{ ...object, documentPreviewId: asset.id }],
        }),
      ),
    };
    await assert.rejects(
      target.store.importBoard({ bytes: zipSync(invalidPreview) }),
      /preview image asset/i,
    );
    delete entries['assets/' + preview.id];
    await assert.rejects(target.store.importBoard({ bytes: zipSync(entries) }), /missing|damaged/i);
  } finally {
    store.close();
    target.store.close();
  }
});

test('document saves require originals and real image preview assets', async () => {
  const { store } = fixture();
  try {
    const asset = await store.importAsset({ bytes: pdf, name: 'report.pdf' });
    const board = store.createBoard({ name: 'References' });
    for (const object of [
      document('f'.repeat(64)),
      document(asset.id, { documentPreviewId: 'f'.repeat(64) }),
      document(asset.id, { documentPreviewId: asset.id }),
    ]) {
      assert.throws(
        () => store.patchBoard({ id: board.id, revision: 0, upserts: [object] }),
        /asset|preview/i,
      );
    }
    assert.equal(store.loadBoard({ id: board.id }).objects.length, 0);
  } finally {
    store.close();
  }
});

test('search finds document titles, original filenames, and extracted excerpts independently', async () => {
  const { store } = fixture();
  try {
    const asset = await store.importAsset({ bytes: pdf, name: 'report.pdf' });
    const board = store.createBoard({ name: 'References' });
    const object = document(asset.id);
    store.patchBoard({ id: board.id, revision: 0, upserts: [object] });
    for (const query of [
      'Research outline',
      'original-report.pdf',
      'searchable document excerpt',
    ]) {
      const result = store.searchContent({ query }).results;
      assert.equal(result.length, 1);
      assert.equal(result[0].objectId, 'document');
      assert.equal(result[0].type, 'document');
      assert.ok(result[0].excerpt.includes(query));
    }
    store.patchBoard({ id: board.id, revision: 1, upserts: [{ ...object, documentTitle: '' }] });
    assert.equal(store.searchContent({ query: 'Research outline' }).results.length, 0);
    assert.equal(store.searchContent({ query: 'original-report.pdf' }).results.length, 1);
  } finally {
    store.close();
  }
});

test('MCP imports empty text and preserves complete document objects without sending binary image blocks', async () => {
  const { store } = fixture();
  try {
    const definitions = tools((command, args) =>
      command === 'asset' ? store.readAsset(args) : store[command](args),
    );
    const call = async (name, args) => {
      const tool = definitions.find((entry) => entry.name === name);
      return tool.run(z.object(tool.schema).parse(args));
    };
    const uploaded = JSON.parse(
      (await call('import_media', { base64: '', name: 'Empty.txt' })).content[0].text,
    );
    assert.equal(uploaded.bytes, 0);
    assert.equal(uploaded.mime, 'text/plain');
    const board = store.createBoard({ name: 'MCP documents' });
    const object = document(uploaded.id, {
      text: 'Empty.txt',
      documentBytes: 0,
      documentMime: 'text/plain',
    });
    await call('edit_board', { id: board.id, revision: 0, upserts: [object] });
    const read = JSON.parse((await call('read_board', { id: board.id })).content[0].text);
    assert.deepEqual(read.objects, [object]);
    const response = await call('read_asset', { id: uploaded.id });
    assert.equal(response.content.length, 1);
    assert.equal(response.content[0].type, 'text');
    assert.equal(JSON.parse(response.content[0].text).contentType, 'text/plain');
  } finally {
    store.close();
  }
});

test('native downloads copy original bytes under the chosen safe filename and honor cancellation', async () => {
  const { createAssetDownload } = require('../electron/document-assets.cjs');
  assert.equal(typeof createAssetDownload, 'function');
  const { root, store } = fixture();
  try {
    const asset = await store.importAsset({ bytes: pdf, name: 'original.pdf' });
    const target = join(root, 'saved.pdf');
    let cancel = false;
    const names = [];
    const service = createAssetDownload({
      readAsset: (args) => store.readAsset(args),
      getWindow: () => null,
      dialog: {
        showSaveDialog: async (_window, options) => {
          names.push(options.defaultPath);
          return cancel ? { canceled: true } : { canceled: false, filePath: target };
        },
      },
    });
    assert.equal(await service.save({ id: asset.id, name: '../folder\\Résumé.pdf' }), true);
    assert.deepEqual(readFileSync(target), pdf);
    assert.deepEqual(names, ['Résumé.pdf']);
    const empty = await store.importAsset({ bytes: Buffer.alloc(0), name: 'Empty.txt' });
    assert.equal(await service.save({ id: empty.id, name: 'CON.txt' }), true);
    assert.equal(names[1], '_CON.txt');
    assert.equal(readFileSync(target).length, 0);
    assert.equal(await service.save({ id: empty.id, name: 'a'.repeat(300) + '.t?xt' }), true);
    assert.ok(names[2].length <= 240);
    assert.ok(!/[<>:"/\\|?*\x00-\x1f]/.test(names[2]));
    cancel = true;
    assert.equal(await service.save({ id: asset.id, name: 'original.pdf' }), false);
    assert.equal(
      readFileSync(target).length,
      0,
      'cancellation leaves existing destination unchanged',
    );
    await assert.rejects(service.save({ id: '../invalid', name: 'report.pdf' }), /invalid/i);
    assert.equal(names.length, 4, 'invalid asset IDs never open the native dialog');
    assert.ok(!readdirSync(root).some((name) => name.endsWith('.tmp')));
  } finally {
    store.close();
  }
});

test('empty attachment responses succeed and normal attachment byte ranges remain exact', async () => {
  const { assetResponse } = require('../electron/document-assets.cjs');
  assert.equal(typeof assetResponse, 'function');
  const { root, store } = fixture();
  try {
    const file = join(root, 'response.txt');
    writeFileSync(file, Buffer.alloc(0));
    let response = assetResponse({ file, contentType: 'text/plain' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Length'), '0');
    assert.equal((await response.arrayBuffer()).byteLength, 0);
    response = assetResponse({ file, contentType: 'text/plain' }, 'bytes=0-');
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('Content-Range'), 'bytes */0');
    writeFileSync(file, Buffer.from('abcdef'));
    response = assetResponse({ file, contentType: 'text/plain' }, 'bytes=1-3');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), 'bytes 1-3/6');
    assert.equal(await response.text(), 'bcd');
  } finally {
    store.close();
  }
});
