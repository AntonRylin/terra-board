import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { zip, unzipSync } from 'fflate';

const spec = (pageIndex = 0, rotation = 0, sourceId = 'source') => ({
  id: `sheet-${sourceId}-${pageIndex}-${rotation}`,
  sourceId,
  pageIndex,
  rotation,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test('sheet rendering adds original and workspace rotation and keeps a white page', async () => {
  const f = fixture({ originalRotation: 90 });
  const canvas = f.canvas();
  await f.api.renderPdfSheet(f.pdf, spec(2, 180), canvas, 400);
  assert.deepEqual(f.requested, [3]);
  assert.equal(canvas.width, 400);
  assert.equal(canvas.height, 300);
  assert.equal(f.renders[0].viewport.rotation, 270);
  assert.equal(f.renders[0].background, '#ffffff');
  assert.equal(f.renders[0].canvas, canvas);
  await f.api.renderPdfSheet(f.pdf, spec(0, -90), canvas, 300);
  assert.equal(f.renders[1].viewport.rotation, 0);
  assert.equal(canvas.width, 300);
  assert.equal(canvas.height, 400);
});

test('sheet rendering bounds both edge length and integer pixel area, including very thin pages', async () => {
  for (const [width, height, maxPixels] of [
    [10000, 10000, 6000000],
    [10000, 20, 16000000],
    [10000000, 1, 1],
  ]) {
    const f = fixture({ pageWidth: width, pageHeight: height });
    const canvas = f.canvas();
    await f.api.renderPdfSheet(f.pdf, spec(), canvas, 100000000, undefined, maxPixels);
    assert.ok(canvas.width >= 1 && canvas.height >= 1);
    assert.ok(canvas.width <= 8192 && canvas.height <= 8192);
    assert.ok(canvas.width * canvas.height <= maxPixels);
    assert.ok(f.renders[0].viewport.width <= canvas.width + 1e-8);
    assert.ok(f.renders[0].viewport.height <= canvas.height + 1e-8);
  }
});

test('invalid dimensions and render failures release the supplied canvas', async () => {
  for (const width of [0, -1, NaN, Infinity]) {
    const f = fixture(),
      canvas = f.canvas();
    await assert.rejects(f.api.renderPdfSheet(f.pdf, spec(), canvas, width), /width/i);
    assert.equal(canvas.width, 1);
    assert.equal(canvas.height, 1);
  }
  const f = fixture({
    render: () => ({ promise: Promise.reject(Error('Broken page')), cancel() {} }),
  });
  const canvas = f.canvas();
  await assert.rejects(f.api.renderPdfSheet(f.pdf, spec(), canvas, 500), /Broken page/);
  assert.equal(canvas.width, 1);
  assert.equal(canvas.height, 1);
});

test('cancellation before or during page acquisition prevents rendering and releases pixels', async () => {
  const before = new AbortController(),
    f = fixture();
  before.abort();
  const canvas = f.canvas();
  await assert.rejects(f.api.renderPdfSheet(f.pdf, spec(), canvas, 300, before.signal), {
    name: 'AbortError',
  });
  assert.equal(f.requested.length, 0);
  const waiting = deferred(),
    abort = new AbortController();
  const g = fixture({ getPage: () => waiting.promise }),
    pending = g.api.renderPdfSheet(g.pdf, spec(), canvas, 300, abort.signal);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  waiting.resolve(g.page(1));
  await Promise.resolve();
  assert.equal(g.renders.length, 0);
  assert.equal(canvas.width, 1);
  assert.equal(canvas.height, 1);
});

test('cancellation of an active renderer cancels its task and ignores a later completion', async () => {
  const waiting = deferred(),
    abort = new AbortController();
  let cancelled = 0;
  const f = fixture({
    render: () => ({
      promise: waiting.promise,
      cancel() {
        cancelled++;
      },
    }),
  });
  const canvas = f.canvas(),
    pending = f.api.renderPdfSheet(f.pdf, spec(), canvas, 300, abort.signal);
  await until(() => f.renders.length);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, 1);
  waiting.resolve();
  await Promise.resolve();
  assert.equal(canvas.width, 1);
  assert.equal(canvas.height, 1);
});

test('single page PNG and JPEG conversions use 144dpi, current rotation and correct filenames', async () => {
  for (const format of ['png', 'jpg']) {
    const f = fixture({ pageWidth: 100, pageHeight: 50 });
    const result = await f.api.convertPdfPages(
      new Map([['source', f.pdf]]),
      [spec(0, 90)],
      format,
      'Project.v2.PDF',
    );
    assert.equal(result.name, `Project.v2-page.${format}`);
    const encoded = JSON.parse(new TextDecoder().decode(result.bytes));
    assert.equal(encoded.width, 100);
    assert.equal(encoded.height, 200);
    assert.equal(encoded.rotation, 90);
    assert.equal(encoded.mime, format === 'jpg' ? 'image/jpeg' : 'image/png');
    assert.equal(f.canvases[0].width, 1);
    assert.equal(f.canvases[0].height, 1);
  }
});

test('multi-page image archives preserve ordered duplicates, source selection, extension and sequential canvas cleanup', async () => {
  for (const format of ['png', 'jpg']) {
    const f = fixture(),
      progress = [];
    const second = { numPages: 3, getPage: (index) => Promise.resolve(f.page(index, 'second')) };
    const order = Object.freeze([
      Object.freeze(spec(0, 0, 'second')),
      Object.freeze(spec(2)),
      Object.freeze(spec(2, 90)),
    ]);
    const result = await f.api.convertPdfPages(
      new Map([
        ['source', f.pdf],
        ['second', second],
      ]),
      order,
      format,
      'bundle.pdf',
      undefined,
      (done, total) => progress.push([done, total]),
    );
    assert.equal(result.name, 'bundle-pages.zip');
    const contents = unzipSync(result.bytes);
    assert.deepEqual(Object.keys(contents), [
      `page-001.${format}`,
      `page-002.${format}`,
      `page-003.${format}`,
    ]);
    const pages = Object.values(contents).map((bytes) =>
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    assert.deepEqual(
      pages.map((page) => [page.source, page.index, page.rotation]),
      [
        ['second', 1, 0],
        ['source', 3, 0],
        ['source', 3, 90],
      ],
    );
    assert.ok(
      pages.every(
        (page) => page.width * page.height <= 16000000 && Math.max(page.width, page.height) <= 8192,
      ),
    );
    assert.ok(f.liveBeforeRender.every((count) => count === 1));
    assert.ok(f.canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
    assert.deepEqual(progress, [
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  }
});

test('conversion rejects empty, oversized, missing and invalid page selections before doing work', async () => {
  const f = fixture(),
    sources = new Map([['source', f.pdf]]);
  for (const [pages, message] of [
    [[], /select|page/i],
    [Array.from({ length: 501 }, () => spec()), /500/],
    [[spec(0, 0, 'missing')], /source|missing/i],
    [[spec(99)], /page/i],
    [[spec(0, 45)], /rotation/i],
  ]) {
    await assert.rejects(f.api.convertPdfPages(sources, pages, 'png', 'file.pdf'), message);
  }
  assert.equal(f.requested.length, 0);
  assert.equal(f.canvases.length, 0);
});

test('failed image encoding and cumulative encoded size limits release every temporary canvas', async () => {
  const failed = fixture({ blob: () => null });
  await assert.rejects(
    failed.api.convertPdfPages(new Map([['source', failed.pdf]]), [spec()], 'png', 'file.pdf'),
    /encod|image/i,
  );
  assert.ok(failed.canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
  let reads = 0;
  const huge = fixture({
    blob: (_canvas, type) => ({
      size: 80 * 1024 * 1024,
      type,
      arrayBuffer: async () => {
        reads++;
        return new ArrayBuffer(80 * 1024 * 1024);
      },
    }),
  });
  await assert.rejects(
    huge.api.convertPdfPages(new Map([['source', huge.pdf]]), [spec(), spec(1)], 'png', 'file.pdf'),
    /128 MB/i,
  );
  assert.equal(reads, 1, 'reject the next large Blob before allocating its ArrayBuffer');
  assert.equal(huge.zipCalls.length, 0);
  assert.ok(huge.canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
});

test('cancellation while ZIP creation is pending terminates work and rejects a late ZIP response', async () => {
  const abort = new AbortController();
  let callback,
    stopped = 0;
  const f = fixture({
    zip: (_files, _options, cb) => {
      callback = cb;
      return () => {
        stopped++;
      };
    },
  });
  const pending = f.api.convertPdfPages(
    new Map([['source', f.pdf]]),
    [spec(), spec(1)],
    'png',
    'file.pdf',
    abort.signal,
  );
  await until(() => callback);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(stopped, 1);
  callback(null, new Uint8Array([1, 2, 3]));
  await Promise.resolve();
});

test('TXT conversion preserves page order, Unicode, word fragments, explicit and positional line breaks as plain text', async () => {
  const item = (str, x, y, width, hasEOL = false) =>
    Object.freeze({
      str,
      dir: 'ltr',
      transform: [10, 0, 0, 10, x, y],
      width,
      height: 10,
      fontName: 'font',
      hasEOL,
    });
  const pages = [
    Object.freeze([
      item('Hel', 0, 100, 15),
      item('lo', 15, 100, 10),
      item('world', 31, 100, 25, true),
      { type: 'beginMarkedContent', id: 'tag' },
      item('<b>literal</b>', 0, 80, 60),
      item('next', 0, 60, 20),
    ]),
    Object.freeze([item('Résumé 👋', 0, 100, 50, true)]),
  ];
  const f = fixture({ text: (index) => pages[index - 1] });
  const result = await f.api.convertPdfPages(
    new Map([['source', f.pdf]]),
    [spec(1), spec(0, 90), spec(1)],
    'txt',
    'Project.v2.pdf',
  );
  assert.equal(result.name, 'Project.v2.txt');
  assert.equal(
    new TextDecoder().decode(result.bytes),
    'Résumé 👋\n\f\nHello world\n<b>literal</b>\nnext\n\f\nRésumé 👋',
  );
  assert.deepEqual(f.requested, [2, 1, 2]);
  assert.equal(f.canvases.length, 0);
  assert.equal(f.renders.length, 0);
});

test('TXT conversion reports image-only PDFs and cancellation without producing a misleading blank file', async () => {
  const f = fixture({ text: () => [] });
  await assert.rejects(
    f.api.convertPdfPages(new Map([['source', f.pdf]]), [spec()], 'txt', 'scan.pdf'),
    /selectable text|OCR/i,
  );
  const wait = deferred(),
    abort = new AbortController();
  const g = fixture({ textPromise: wait.promise });
  const pending = g.api.convertPdfPages(
    new Map([['source', g.pdf]]),
    [spec()],
    'txt',
    'scan.pdf',
    abort.signal,
  );
  await until(() => g.textRequests.length);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  wait.resolve({ items: [] });
});

test('text extraction keeps embedded line endings while removing non-text control characters', async () => {
  const f = fixture({
    text: () => [
      {
        str: 'One\rTwo\r\nThree\u0000',
        dir: 'ltr',
        transform: [10, 0, 0, 10, 0, 100],
        width: 50,
        height: 10,
        fontName: 'font',
        hasEOL: false,
      },
    ],
  });
  const result = await f.api.convertPdfPages(
    new Map([['source', f.pdf]]),
    [spec()],
    'txt',
    'lines.pdf',
  );
  assert.equal(new TextDecoder().decode(result.bytes), 'One\nTwo\nThree');
});

test('cancelling image encoding releases the canvas and never starts the next page', async () => {
  const wait = deferred(),
    abort = new AbortController();
  let reads = 0;
  const f = fixture({
    blob: (_canvas, type) => ({
      size: 10,
      type,
      arrayBuffer() {
        reads++;
        return wait.promise;
      },
    }),
  });
  const pending = f.api.convertPdfPages(
    new Map([['source', f.pdf]]),
    [spec(), spec(1)],
    'png',
    'file.pdf',
    abort.signal,
  );
  await until(() => reads);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(f.requested, [1]);
  assert.equal(f.canvases[0].width, 1);
  assert.equal(f.canvases[0].height, 1);
  wait.resolve(new ArrayBuffer(10));
});

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw Error('Expected asynchronous stage was not reached');
}

function fixture(options = {}) {
  const requested = [],
    renders = [],
    canvases = [],
    liveBeforeRender = [],
    textRequests = [],
    zipCalls = [];
  function page(index, source = 'source') {
    return {
      rotate: options.originalRotation || 0,
      getViewport({ scale, rotation = options.originalRotation || 0 }) {
        const swap = rotation % 180 !== 0;
        return {
          rotation,
          scale,
          width: (swap ? options.pageHeight || 800 : options.pageWidth || 600) * scale,
          height: (swap ? options.pageWidth || 600 : options.pageHeight || 800) * scale,
        };
      },
      render(params) {
        renders.push(params);
        params.canvas.page = { source, index, rotation: params.viewport.rotation };
        liveBeforeRender.push(
          canvases.filter((canvas) => canvas.width > 1 || canvas.height > 1).length,
        );
        return options.render?.(params) || { promise: Promise.resolve(), cancel() {} };
      },
      getTextContent() {
        textRequests.push(index);
        return options.textPromise || Promise.resolve({ items: options.text?.(index) || [] });
      },
    };
  }
  const pdf = {
    numPages: 10,
    getPage(index) {
      requested.push(index);
      return options.getPage?.(index) || Promise.resolve(page(index));
    },
  };
  function canvas() {
    const result = {
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: '', fillRect() {} }),
      toBlob(callback, mime) {
        const blob = options.blob
          ? options.blob(result, mime)
          : new Blob(
              [
                JSON.stringify({
                  ...result.page,
                  width: result.width,
                  height: result.height,
                  mime,
                }),
              ],
              { type: mime },
            );
        queueMicrotask(() => callback(blob));
      },
    };
    canvases.push(result);
    return result;
  }
  const file = new URL('../src/canvas/pdf-render.ts', import.meta.url),
    api = {};
  if (existsSync(file)) {
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    vm.runInNewContext(code, {
      exports: api,
      Uint8Array,
      ArrayBuffer,
      TextEncoder,
      TextDecoder,
      DOMException,
      Blob,
      document: { createElement: canvas },
      require(id) {
        if (id === 'fflate')
          return {
            zip(...args) {
              zipCalls.push(args[0]);
              return (options.zip || zip)(...args);
            },
          };
        throw Error('Unexpected runtime dependency ' + id);
      },
    });
  }
  assert.equal(typeof api.renderPdfSheet, 'function', 'PDF renderer API is available');
  assert.equal(typeof api.convertPdfPages, 'function', 'PDF conversion API is available');
  return {
    api,
    pdf,
    page,
    canvas,
    requested,
    renders,
    canvases,
    liveBeforeRender,
    textRequests,
    zipCalls,
  };
}
