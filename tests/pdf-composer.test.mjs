import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { z } from 'zod';
import sharp from 'sharp';
import { twoPagePdf } from './document-fixtures.mjs';
import { clipboardObjects } from '../src/canvas/content.ts';
import {
  createPdfComposer,
  appendPdfComposer,
  movePdfComposerPage,
  movePdfComposerColumn,
  addPdfComposerColumn,
  pdfComposerValue,
} from '../src/canvas/pdf-composer.ts';
const require = createRequire(import.meta.url);
const { Store, objectValue } = require('../electron/store.cjs');
const { tools } = require('../electron/mcp-tools.cjs');
const pdfSource = {
  id: 'source-pdf',
  assetId: 'a'.repeat(64),
  name: 'Research.pdf',
  kind: 'pdf',
  pageCount: 2,
};
const imageSource = {
  id: 'source-image',
  assetId: 'b'.repeat(64),
  name: 'Cover.png',
  kind: 'image',
  pageCount: 1,
};
function composer() {
  return {
    sources: [{ ...pdfSource }, { ...imageSource }],
    columns: [
      {
        id: 'column-pdf',
        name: 'First export',
        pages: [
          { id: 'page-1', sourceId: 'source-pdf', pageIndex: 0, rotation: 0 },
          { id: 'page-2', sourceId: 'source-pdf', pageIndex: 1, rotation: 90 },
        ],
      },
      {
        id: 'column-image',
        name: 'Cover export',
        pages: [{ id: 'page-3', sourceId: 'source-image', pageIndex: 0, rotation: -90 }],
      },
    ],
  };
}
const frame = (pdfComposer = composer(), overrides = {}) => ({
  id: 'composer',
  type: 'frame',
  x: 10,
  y: 20,
  width: 600,
  height: 500,
  z: 1,
  text: 'Page collection',
  pdfComposer,
  ...overrides,
});
const clone = (value) => structuredClone(value);
function fixture() {
  mkdirSync(resolve('.local-test'), { recursive: true });
  const root = mkdtempSync(resolve('.local-test/pdf-composer-'));
  return { root, store: new Store(root) };
}
async function importedComposer(store) {
  const pdf = twoPagePdf();
  const image = await sharp({ create: { width: 24, height: 12, channels: 3, background: '#a73' } })
    .png()
    .toBuffer();
  const a = await store.importAsset({ name: 'Research.pdf', bytes: pdf });
  const b = await store.importAsset({ name: 'Cover.png', bytes: image });
  const value = composer();
  value.sources[0].assetId = a.id;
  value.sources[1].assetId = b.id;
  return {
    value,
    files: [
      [a.id, pdf],
      [b.id, image],
    ],
  };
}

test('creating and appending composers makes one independent column per input, including repeated assets', () => {
  const input = [pdfSource, imageSource];
  const inputBefore = clone(input);
  const initial = createPdfComposer(input);
  assert.deepEqual(
    initial.columns.map((c) => c.name),
    ['Research.pdf', 'Cover.png'],
  );
  assert.deepEqual(
    initial.columns.map((c) => c.pages.map((p) => [p.sourceId, p.pageIndex, p.rotation])),
    [
      [
        ['source-pdf', 0, 0],
        ['source-pdf', 1, 0],
      ],
      [['source-image', 0, 0]],
    ],
  );
  const before = clone(initial);
  const appended = appendPdfComposer(initial, [pdfSource, { ...pdfSource, id: 'second-copy' }]);
  assert.equal(appended.columns.length, 4);
  assert.equal(appended.sources.length, 4);
  assert.equal(new Set(appended.sources.map((s) => s.id)).size, 4);
  assert.deepEqual(
    appended.sources.map((s) => s.assetId),
    [pdfSource.assetId, imageSource.assetId, pdfSource.assetId, pdfSource.assetId],
  );
  assert.deepEqual(initial, before);
  assert.deepEqual(input, inputBefore);
  assert.deepEqual(pdfComposerValue(appended), appended);
});

test('page movement uses final indexes, preserves identity and allows splitting into empty columns', () => {
  const original = composer(),
    before = clone(original);
  let result = movePdfComposerPage(original, 'page-1', 'column-image', 0);
  assert.deepEqual(
    result.columns.map((c) => c.pages.map((p) => p.id)),
    [['page-2'], ['page-1', 'page-3']],
  );
  assert.deepEqual(result.columns[1].pages[0], original.columns[0].pages[0]);
  result = movePdfComposerPage(result, 'page-1', 'column-image', 1);
  assert.deepEqual(
    result.columns[1].pages.map((p) => p.id),
    ['page-3', 'page-1'],
  );
  result = addPdfComposerColumn(result, 'Split chapter');
  const last = result.columns.at(-1);
  assert.equal(last.name, 'Split chapter');
  assert.deepEqual(last.pages, []);
  result = movePdfComposerPage(result, 'page-2', last.id, 999);
  assert.deepEqual(result.columns[0].pages, []);
  assert.deepEqual(
    result.columns.at(-1).pages.map((p) => p.id),
    ['page-2'],
  );
  assert.deepEqual(result.sources, original.sources);
  assert.deepEqual(original, before);
});

test('column movement keeps pages and names intact and rejects stale page/column targets', () => {
  const original = composer(),
    before = clone(original);
  const moved = movePdfComposerColumn(original, 'column-pdf', 1);
  assert.deepEqual(moved.columns, [before.columns[1], before.columns[0]]);
  assert.deepEqual(movePdfComposerColumn(moved, 'column-pdf', -10), original);
  assert.deepEqual(original, before);
  assert.throws(() => movePdfComposerPage(original, 'deleted-page', 'column-pdf', 0), /page/i);
  assert.throws(() => movePdfComposerPage(original, 'page-1', 'deleted-column', 0), /column/i);
  assert.throws(() => movePdfComposerColumn(original, 'deleted-column', 0), /column/i);
  assert.throws(() => movePdfComposerPage(original, 'page-1', 'column-pdf', NaN), /index/i);
});

test('composer metadata is deeply copied through clipboard and duplicate edits leave the original unchanged', () => {
  const original = frame(),
    before = clone(original);
  const copied = clipboardObjects([original])[0];
  assert.deepEqual(copied, original);
  copied.pdfComposer.columns[0].name = 'Renamed copy';
  copied.pdfComposer.sources[0].name = 'Local display name.pdf';
  copied.pdfComposer.columns[0].pages[0].rotation = 180;
  assert.deepEqual(original, before);
  const duplicate = clipboardObjects([{ ...original, id: 'duplicate' }])[0];
  duplicate.pdfComposer = movePdfComposerPage(duplicate.pdfComposer, 'page-1', 'column-image', 1);
  assert.deepEqual(original, before);
  assert.deepEqual(
    duplicate.pdfComposer.columns[1].pages.map((p) => p.id),
    ['page-3', 'page-1'],
  );
});

test('store and clipboard validators agree on source identity, page references, rotation and frame restrictions', () => {
  const valid = frame();
  assert.deepEqual(objectValue(valid), valid);
  const invalid = [
    (value) => {
      value.sources[0].assetId = '../../unsafe';
    },
    (value) => {
      value.sources[0].pageCount = 0;
    },
    (value) => {
      value.sources[0].pageCount = 501;
    },
    (value) => {
      value.sources[0].kind = 'video';
    },
    (value) => {
      value.sources[1].id = value.sources[0].id;
    },
    (value) => {
      value.columns[1].id = value.columns[0].id;
    },
    (value) => {
      value.columns[1].pages[0].id = value.columns[0].pages[0].id;
    },
    (value) => {
      value.columns[1].pages[0].sourceId = 'missing';
    },
    (value) => {
      value.columns[0].pages[1].pageIndex = 2;
    },
    (value) => {
      value.columns[0].pages[1].pageIndex = 0.5;
    },
    (value) => {
      value.columns[0].pages[1].rotation = 45;
    },
    (value) => {
      value.columns[0].pages[1].rotation = Infinity;
    },
  ];
  for (const change of invalid) {
    const value = composer();
    change(value);
    assert.throws(() => pdfComposerValue(value));
    assert.throws(() => objectValue(frame(value)));
    assert.throws(() => clipboardObjects([frame(value)]));
  }
  for (const bad of [
    frame(composer(), { type: 'rect' }),
    frame(composer(), { gallery: { direction: 'below', size: 200, gap: 10 } }),
  ]) {
    assert.throws(() => objectValue(bad), /composer|frame|gallery/i);
    assert.throws(() => clipboardObjects([bad]), /composer|frame|gallery/i);
  }
  const extras = composer();
  extras.sources[0].bytes = [1, 2, 3];
  extras.columns[0].pages[0].untrusted = true;
  assert.deepEqual(objectValue(frame(extras)), valid);
  assert.deepEqual(clipboardObjects([frame(extras)])[0], valid);
});

test('500-page, source and column limits hold while empty split columns remain valid', () => {
  const full = createPdfComposer([{ ...pdfSource, pageCount: 500 }]);
  assert.equal(pdfComposerValue(full).columns[0].pages.length, 500);
  assert.throws(() => appendPdfComposer(full, [imageSource]), /500|limit/i);
  const columns = {
    sources: [],
    columns: Array.from({ length: 500 }, (_, i) => ({ id: `c-${i}`, name: 'Empty', pages: [] })),
  };
  assert.deepEqual(pdfComposerValue(columns), columns);
  assert.throws(() => addPdfComposerColumn(columns), /500|limit/i);
  const manySources = {
    sources: Array.from({ length: 501 }, (_, i) => ({ ...pdfSource, id: `s-${i}` })),
    columns: [],
  };
  assert.throws(() => pdfComposerValue(manySources), /500|limit/i);
  const tooManyPages = clone(full);
  tooManyPages.columns.push({
    id: 'extra-column',
    name: 'Extra',
    pages: [{ id: 'extra-page', sourceId: pdfSource.id, pageIndex: 0, rotation: 0 }],
  });
  for (const value of [
    tooManyPages,
    manySources,
    { ...columns, columns: [...columns.columns, { id: 'extra-column', name: '', pages: [] }] },
  ]) {
    assert.throws(() => pdfComposerValue(value));
    assert.throws(() => objectValue(frame(value)));
    assert.throws(() => clipboardObjects([frame(value)]));
  }
});

test('storage, reopen and portable boards retain nested source assets even without top-level asset IDs', async () => {
  const f = fixture(),
    target = fixture();
  let current = f.store;
  try {
    const { value, files } = await importedComposer(current);
    // A source stays retained when its pages have all been moved or removed.
    value.columns[1].pages = [];
    value.sources.push({
      ...value.sources[0],
      id: 'source-pdf-again',
      name: 'Second reference.pdf',
    });
    value.columns.push({
      id: 'repeat-column',
      name: 'Repeat',
      pages: [{ id: 'repeat-page', sourceId: 'source-pdf-again', pageIndex: 1, rotation: 0 }],
    });
    const object = frame(value);
    const board = current.createBoard({ name: 'Portable composer' });
    current.patchBoard({ id: board.id, revision: 0, upserts: [object] });
    current.close();
    current = new Store(f.root);
    assert.deepEqual(current.loadBoard({ id: board.id }).objects, [object]);
    const portable = await current.exportBoard({ id: board.id });
    const entries = unzipSync(portable);
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    assert.equal(manifest.assets.length, 2);
    for (const [id, bytes] of files) assert.deepEqual(Buffer.from(entries[`assets/${id}`]), bytes);
    const imported = await target.store.importBoard({ bytes: portable });
    assert.deepEqual(target.store.loadBoard({ id: imported.id }).objects, [object]);
    for (const [id, bytes] of files)
      assert.deepEqual(readFileSync(target.store.asset({ id, variant: 'original' }).file), bytes);
  } finally {
    current.close();
    target.store.close();
  }
});

test('missing nested assets reject board patches and incomplete portable imports atomically', async () => {
  const f = fixture(),
    target = fixture();
  try {
    const board = f.store.createBoard({ name: 'Missing references' });
    assert.throws(
      () => f.store.patchBoard({ id: board.id, revision: 0, upserts: [frame()] }),
      /missing.*asset|missing.*source/i,
    );
    assert.equal(f.store.loadBoard({ id: board.id }).revision, 0);
    const { value } = await importedComposer(f.store);
    f.store.patchBoard({ id: board.id, revision: 0, upserts: [frame(value)] });
    const entries = unzipSync(await f.store.exportBoard({ id: board.id }));
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    manifest.assets = manifest.assets.filter((a) => a.id !== value.sources[1].assetId);
    entries['manifest.json'] = strToU8(JSON.stringify(manifest));
    const count = target.store.library().boards.length;
    await assert.rejects(
      target.store.importBoard({ bytes: zipSync(entries) }),
      /missing.*media|missing.*asset|missing.*source/i,
    );
    assert.equal(target.store.library().boards.length, count);
  } finally {
    f.store.close();
    target.store.close();
  }
});

test('search finds composer column names and original filenames', async () => {
  const { store } = fixture();
  try {
    const { value } = await importedComposer(store);
    value.columns[0].name = 'Quarterly chapter';
    value.sources[0].name = 'Client research.pdf';
    const board = store.createBoard({ name: 'Searchable composer' });
    store.patchBoard({ id: board.id, revision: 0, upserts: [frame(value)] });
    for (const query of ['Quarterly chapter', 'Client research.pdf']) {
      const results = store.searchContent({ query }).results;
      assert.equal(results.length, 1);
      assert.equal(results[0].objectId, 'composer');
      assert.ok(results[0].excerpt.includes(query));
    }
  } finally {
    store.close();
  }
});

test('MCP complete object edits preserve composers and reject invalid nested references', async () => {
  const { store } = fixture();
  try {
    const { value } = await importedComposer(store);
    const definitions = tools((command, args) => store[command](args));
    const call = async (name, args) => {
      const tool = definitions.find((t) => t.name === name);
      return JSON.parse((await tool.run(z.object(tool.schema).parse(args))).content[0].text);
    };
    const board = store.createBoard({ name: 'MCP composer' });
    const original = frame(value);
    await call('edit_board', { id: board.id, revision: 0, upserts: [original] });
    const read = await call('read_board', { id: board.id });
    assert.deepEqual(read.objects, [original]);
    const changed = { ...read.objects[0], x: 999 };
    await call('edit_board', { id: board.id, revision: read.revision, upserts: [changed] });
    assert.deepEqual((await call('read_board', { id: board.id })).objects, [changed]);
    const invalid = clone(changed);
    invalid.pdfComposer.columns[0].pages[0].sourceId = 'missing';
    await assert.rejects(
      call('edit_board', { id: board.id, revision: 2, upserts: [invalid] }),
      /source|reference|page/i,
    );
    assert.deepEqual(store.loadBoard({ id: board.id }).objects, [changed]);
  } finally {
    store.close();
  }
});
