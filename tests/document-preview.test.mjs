import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as files from '../src/canvas/document-files.ts';

test('a PDF workspace reuses its explicit preview worker for merged sources', async () => {
  let created = 0;
  const inputs = [];
  const f = previewFixture({
    pdfjs: {
      PDFWorker: class {
        constructor() {
          created++;
        }
      },
      getDocument: (input) => {
        inputs.push(input);
        return { promise: Promise.resolve({ numPages: 2 }), destroy: async () => {} };
      },
    },
  });
  const worker = await f.createPdfPreviewWorker();
  await f.loadPdf(new Uint8Array([1]), undefined, worker);
  await f.loadPdf(new Uint8Array([2]), undefined, worker);
  assert.equal(created, 1);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].worker, worker);
  assert.equal(inputs[1].worker, worker);
});

test('closing a workspace during PDF.js import does not create an orphan preview worker', async () => {
  let created = 0;
  const f = previewFixture({
    pdfjs: {
      PDFWorker: class {
        constructor() {
          created++;
        }
      },
    },
  });
  const controller = new AbortController();
  const pending = f.createPdfPreviewWorker(controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(created, 0);
});

function previewFixture(overrides = {}) {
  const exports = {};
  const pdfjs = { GlobalWorkerOptions: {}, ...overrides.pdfjs };
  const context = vm.createContext({
    exports,
    require: (name) => {
      if (name === './document-files') return files;
      if (name === '../bridge') return { mediaUrl: (id) => `https://local.invalid/${id}` };
      if (name === 'pdfjs-dist') return pdfjs;
      if (name.endsWith('?url')) return '/pdf.worker.mjs';
      throw Error(`Unexpected dependency: ${name}`);
    },
    fetch: overrides.fetch,
    window: { location: { href: 'https://local.invalid/' } },
    URL,
    Uint8Array,
    Error,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(
    ts.transpileModule(
      readFileSync(new URL('../src/canvas/document-preview.ts', import.meta.url), 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  );
  return exports;
}

test('document reads enforce declared and streamed byte limits without retaining oversized bodies', async () => {
  let cancelled = 0;
  const body = () =>
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(6));
      },
      cancel() {
        cancelled++;
      },
    });
  let response = new Response(body(), { headers: { 'content-length': '12' } });
  const f = previewFixture({ fetch: async () => response });
  await assert.rejects(f.documentBytes({ assetId: 'file' }, 10), /Preview is limited/);
  assert.equal(cancelled, 1);
  response = new Response(body());
  await assert.rejects(f.documentBytes({ assetId: 'file' }, 10), /Preview is limited/);
  assert.equal(cancelled, 2);
});

test('cancelled queued previews do not read files or block subsequent board previews', async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const f = previewFixture({
    fetch: async () => {
      reads++;
      return new Response('next board');
    },
  });
  const o = { assetId: 'file', text: 'notes.txt' };
  assert.deepEqual(Object.keys(await f.prepareDocumentPreview(o, controller.signal)), []);
  assert.equal(reads, 0);
  assert.equal((await f.prepareDocumentPreview(o)).documentExcerpt, 'next board');
  assert.equal(reads, 1);
});

test('aborting a loading PDF destroys its worker task and releases the pending promise', async () => {
  let destroyed = 0,
    rejectTask,
    started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const task = {
    promise: new Promise((_, reject) => {
      rejectTask = reject;
    }),
    destroy: async () => {
      destroyed++;
      rejectTask(Error('worker stopped'));
    },
  };
  const f = previewFixture({
    pdfjs: {
      getDocument: () => {
        started();
        return task;
      },
    },
  });
  const controller = new AbortController();
  const loading = f.loadPdf(new Uint8Array(), controller.signal);
  await ready;
  controller.abort();
  await assert.rejects(loading, /could not be previewed/);
  assert.ok(destroyed >= 1);
});

test('closing a PDF during rendering cancels the render and releases its canvas pixels', async () => {
  let cancelled = 0,
    rejectRender;
  const task = {
    promise: new Promise((_, reject) => {
      rejectRender = reject;
    }),
    cancel() {
      cancelled++;
      rejectRender(Error('render cancelled'));
    },
  };
  const page = {
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => task,
  };
  const canvas = { width: 0, height: 0 };
  const controller = new AbortController();
  const f = previewFixture();
  const rendering = f.paintPdfPage(page, canvas, 1200, controller.signal);
  controller.abort();
  await assert.rejects(rendering, /render cancelled/);
  assert.equal(cancelled, 1);
  assert.equal(canvas.width, 1);
  assert.equal(canvas.height, 1);
});
