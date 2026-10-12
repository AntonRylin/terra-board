import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { PDFDocument, degrees } from 'pdf-lib';
import sharp from 'sharp';
import { compressPdfPages } from '../src/canvas/pdf-size.ts';
import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { randomBytes } from 'node:crypto';
import {
  inspectPdfSource,
  assemblePdf,
  MAX_PDF_PAGES,
  MAX_PDF_WORKSPACE_BYTES,
} from '../src/canvas/pdf-edit.ts';

const file = new URL('../src/canvas/pdf-composer-files.ts', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
async function pdfFixture() {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 500]).setRotation(degrees(90));
  pdf.addPage([420, 600]);
  return pdf.save();
}
function fixture(assets = new Map(), overrides = {}) {
  const calls = [],
    destroyed = [],
    workers = [];
  let serial = 0;
  const module = { exports: {} };
  if (existsSync(file)) {
    const source = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, {
      module,
      exports: module.exports,
      AbortController,
      DOMException,
      Uint8Array,
      Map,
      Set,
      Promise,
      document: { createElement: () => createCanvas(1, 1) },
      fetch: async (url, { signal } = {}) => {
        signal?.throwIfAborted();
        calls.push(url);
        if (overrides.fetch) return overrides.fetch(url, signal);
        const bytes = assets.get(url);
        return new Response(bytes || null, { status: bytes ? 200 : 404 });
      },
      require(id) {
        if (id === '../model') return { uid: () => `source-${++serial}` };
        if (id === '../bridge') return { mediaUrl: (asset, variant) => `${asset}/${variant}` };
        if (id === './document-files')
          return {
            documentKind: (name, mime) =>
              /\.pdf$/i.test(name) || mime === 'application/pdf' ? 'pdf' : 'file',
          };
        if (id === './pdf-edit') return { MAX_PDF_PAGES, MAX_PDF_WORKSPACE_BYTES };
        if (id === './pdf-size') return { compressPdfPages };
        if (id === './pdf-edit-client')
          return {
            inspectPdfSourceLocal: overrides.inspect || inspectPdfSource,
            assemblePdfLocal: assemblePdf,
          };
        if (id === './document-preview')
          return {
            createPdfPreviewWorker: async () => {
              const worker = {
                destroyed: false,
                destroy() {
                  this.destroyed = true;
                },
              };
              workers.push(worker);
              return worker;
            },
            loadPdf:
              overrides.loadPdf ||
              (async (bytes, signal, worker) => {
                signal?.throwIfAborted();
                assert.ok(worker);
                const pdf = {
                  numPages: 2,
                  loadingTask: {
                    async destroy() {
                      destroyed.push(pdf);
                    },
                  },
                };
                return pdf;
              }),
          };
        throw Error(`Unexpected import ${id}`);
      },
    });
  }
  const api = (name) => {
    assert.equal(typeof module.exports[name], 'function', `${name} is implemented`);
    return module.exports[name];
  };
  return { api, calls, destroyed, workers };
}
const object = (assetId, text, type = 'document') => ({
  id: assetId,
  type,
  assetId,
  text,
  x: 0,
  y: 0,
  width: 320,
  height: 400,
  z: 1,
});

test('composer size target compresses large PDFs, keeps small vector PDFs intact and releases its renderer', async () => {
  const pdf = await PDFDocument.create();
  const image = await pdf.embedPng(
    await sharp(randomBytes(900 * 1200 * 3), {
      raw: { width: 900, height: 1200, channels: 3 },
    })
      .png()
      .toBuffer(),
  );
  pdf.addPage([450, 600]).drawImage(image, { x: 0, y: 0, width: 450, height: 600 });
  const small = await PDFDocument.create();
  small.addPage([300, 400]).drawText('Keep selectable text');
  const assets = new Map([
    ['large/original', await pdf.save()],
    ['small/original', await small.save()],
  ]);
  let loading;
  const f = fixture(assets, {
    loadPdf: async (bytes) => {
      loading = getDocument({ data: bytes, useSystemFonts: true });
      return loading.promise;
    },
  });
  const composition = (id) => ({
    sources: [{ id, assetId: id, name: `${id}.pdf`, kind: 'pdf', pageCount: 1 }],
    columns: [
      {
        id: 'column',
        name: 'Email export',
        pages: [{ id: 'page', sourceId: id, pageIndex: 0, rotation: 0 }],
      },
    ],
  });
  const result = await f.api('exportComposerColumn')(
    composition('large'),
    'column',
    undefined,
    100000,
  );
  assert.ok(result.bytes.length <= 100000);
  assert.equal((await PDFDocument.load(result.bytes)).getPageCount(), 1);
  assert.equal(loading.destroyed, true);
  loading = undefined;
  const unchanged = await f.api('exportComposerColumn')(
    composition('small'),
    'column',
    undefined,
    100000,
  );
  assert.equal(loading, undefined, 'a small PDF needs no rasterization');
  const check = getDocument({ data: unchanged.bytes, useSystemFonts: true });
  try {
    assert.match(
      (await (await (await check.promise).getPage(1)).getTextContent()).items
        .map((x) => x.str)
        .join(' '),
      /Keep selectable text/,
    );
  } finally {
    await check.destroy();
  }
});

test('composer preparation inspects PDF originals and orientation-normalized full-resolution images', async () => {
  const pdf = await pdfFixture(),
    png = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#4488cc' } })
      .png()
      .toBuffer();
  const f = fixture(
    new Map([
      ['pdf/original', pdf],
      ['image/export', png],
    ]),
  );
  const input = [object('pdf', 'notes.v2.pdf'), object('image', 'scan.final.tiff', 'image')];
  const before = structuredClone(input);
  const sources = await f.api('prepareComposerSources')(input);
  assert.deepEqual(plain(sources), [
    { id: 'source-1', assetId: 'pdf', name: 'notes.v2.pdf', kind: 'pdf', pageCount: 2 },
    { id: 'source-2', assetId: 'image', name: 'scan.final.tiff', kind: 'image', pageCount: 1 },
  ]);
  assert.deepEqual(f.calls, ['pdf/original', 'image/export']);
  assert.deepEqual(input, before);
});

test('composer exports the chosen column in current order with duplicates and rotation', async () => {
  const bytes = await pdfFixture(),
    f = fixture(new Map([['pdf/original', bytes]]));
  const composer = {
    sources: [
      { id: 'src', assetId: 'pdf', kind: 'pdf', name: 'original.pdf', pageCount: 2 },
      { id: 'unused', assetId: 'missing', kind: 'pdf', name: 'unused.pdf', pageCount: 1 },
    ],
    columns: [
      {
        id: 'column',
        name: 'Report.v2.pdf',
        pages: [
          { id: 'b', sourceId: 'src', pageIndex: 1, rotation: 90 },
          { id: 'a', sourceId: 'src', pageIndex: 0, rotation: 180 },
          { id: 'copy', sourceId: 'src', pageIndex: 1, rotation: 0 },
        ],
      },
    ],
  };
  const before = structuredClone(composer);
  const result = await f.api('exportComposerColumn')(composer, 'column');
  assert.equal(result.name, 'Report.v2.pdf');
  assert.equal(result.pageCount, 3);
  assert.deepEqual(f.calls, ['pdf/original']);
  const pdf = await PDFDocument.load(result.bytes);
  assert.deepEqual(
    pdf.getPages().map((page) => [page.getWidth(), page.getHeight(), page.getRotation().angle]),
    [
      [420, 600, 90],
      [300, 500, 270],
      [420, 600, 0],
    ],
  );
  assert.deepEqual(composer, before);
  composer.columns[0].name = 'Draft.2026';
  assert.equal((await f.api('exportComposerColumn')(composer, 'column')).name, 'Draft.2026.pdf');
});

test('column export replaces converted document extensions while preserving dotted basenames', async () => {
  const bytes = await pdfFixture(),
    f = fixture(new Map([['pdf/original', bytes]]));
  const column = {
    id: 'column',
    name: '',
    pages: [{ id: 'page', sourceId: 'source', pageIndex: 0, rotation: 0 }],
  };
  const composer = {
    sources: [{ id: 'source', assetId: 'pdf', kind: 'pdf', name: 'input.pdf', pageCount: 2 }],
    columns: [column],
  };
  for (const extension of [
    'doc',
    'docx',
    'docm',
    'dot',
    'dotx',
    'rtf',
    'odt',
    'ott',
    'txt',
    'text',
    'md',
    'markdown',
    'csv',
    'tsv',
    'log',
    'json',
    'xml',
    'html',
    'htm',
    'xls',
    'xlsx',
    'xlsm',
    'xlsb',
    'ods',
    'ots',
    'ppt',
    'pptx',
    'pptm',
    'odp',
    'odg',
    'PDF',
    'DOCX',
    'TXT',
    'TIFF',
    'ico',
  ]) {
    column.name = `Report.final.v2.${extension}`;
    assert.equal(
      (await f.api('exportComposerColumn')(composer, column.id)).name,
      'Report.final.v2.pdf',
      extension,
    );
  }
  column.name = 'Report.final.v2';
  assert.equal(
    (await f.api('exportComposerColumn')(composer, column.id)).name,
    'Report.final.v2.pdf',
  );
});

test('empty, unsupported, invalid reference and over-limit inputs fail before exporting', async () => {
  const f = fixture();
  await assert.rejects(
    f.api('prepareComposerSources')([object('text', 'notes.txt')]),
    /PDF|image/i,
  );
  await assert.rejects(
    f.api('exportComposerColumn')(
      { sources: [], columns: [{ id: 'empty', name: 'Empty', pages: [] }] },
      'empty',
    ),
    /page/i,
  );
  await assert.rejects(
    f.api('exportComposerColumn')(
      {
        sources: [],
        columns: [
          {
            id: 'missing',
            name: 'Missing',
            pages: [{ id: 'p', sourceId: 'no', pageIndex: 0, rotation: 0 }],
          },
        ],
      },
      'missing',
    ),
    /source|available/i,
  );
  assert.equal(f.calls.length, 0);
  const tooLarge = fixture(new Map(), {
    fetch: async () =>
      new Response(new Uint8Array([1]), {
        headers: { 'content-length': String(MAX_PDF_WORKSPACE_BYTES + 1) },
      }),
  });
  await assert.rejects(
    tooLarge.api('prepareComposerSources')([object('large', 'large.pdf')]),
    /64|large|limit/i,
  );
  const tooMany = fixture(
    new Map([
      ['a/original', new Uint8Array([1])],
      ['b/original', new Uint8Array([1])],
    ]),
    { inspect: async () => ({ pageCount: 300, hasForms: false }) },
  );
  await assert.rejects(
    tooMany.api('prepareComposerSources')([object('a', 'a.pdf'), object('b', 'b.pdf')]),
    /500|pages/i,
  );
});

test('cancellation prevents source fetching and ignores late completed inspection', async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    f.api('prepareComposerSources')([object('pdf', 'source.pdf')], controller.signal),
    { name: 'AbortError' },
  );
  assert.equal(f.calls.length, 0);
  const late = new AbortController();
  const g = fixture(new Map([['pdf/original', new Uint8Array([1])]]), {
    inspect: async () => {
      late.abort();
      return { pageCount: 1, hasForms: false };
    },
  });
  await assert.rejects(
    g.api('prepareComposerSources')([object('pdf', 'source.pdf')], late.signal),
    { name: 'AbortError' },
  );
});

test('visible page previews share one source and worker, releasing only after the last lease', async () => {
  const f = fixture(new Map([['pdf/original', new Uint8Array([1])]]));
  const Pool = f.api('ComposerPreviewPool'),
    pool = new Pool();
  const source = { id: 'src', assetId: 'pdf', name: 'test.pdf', kind: 'pdf', pageCount: 2 };
  const [first, second] = await Promise.all([
    pool.acquire(source),
    pool.acquire({ ...source, id: 'another-reference' }),
  ]);
  assert.equal(first.pdf, second.pdf);
  assert.equal(f.calls.length, 1);
  assert.equal(f.workers.length, 1);
  first.release();
  assert.equal(f.destroyed.length, 0);
  second.release();
  await pool.dispose();
  assert.equal(f.destroyed.length, 1);
  assert.equal(f.workers[0].destroyed, true);
});
