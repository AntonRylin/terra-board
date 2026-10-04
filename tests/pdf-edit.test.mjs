import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFString, degrees } from 'pdf-lib';
import sharp from 'sharp';
import { Worker as NodeWorker } from 'node:worker_threads';
import { twoPagePdf } from './document-fixtures.mjs';
import {
  inspectPdfSource,
  assemblePdf,
  MAX_PDF_WORKSPACE_BYTES,
  MAX_PDF_PAGES,
} from '../src/canvas/pdf-edit.ts';
import { inspectPdfSourceLocal, assemblePdfLocal } from '../src/canvas/pdf-edit-client.ts';

const source = (id, bytes, kind = 'pdf') => ({
  id,
  name: `${id}.${kind}`,
  kind,
  bytes: Uint8Array.from(bytes),
});
const page = (id, sourceId, pageIndex = 0, rotation = 0) => ({
  id,
  sourceId,
  pageIndex,
  rotation,
});
async function pdfWithText(text) {
  const doc = await PDFDocument.create();
  doc.addPage([320, 480]).drawText(text, { x: 30, y: 300 });
  return doc.save();
}
async function textOf(bytes) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true, isEvalSupported: false });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      pages.push(content.items.map((item) => item.str || '').join(' '));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

test('inspection counts actual PDF pages without changing source bytes', async () => {
  const input = source('reference', twoPagePdf());
  const before = input.bytes.slice();
  assert.deepEqual(await inspectPdfSource(input), { pageCount: 2, hasForms: false });
  assert.deepEqual(input.bytes, before);
});

test('assembly reorders and merges vector pages, preserving crops and independent duplicate rotations', async () => {
  const original = await PDFDocument.load(twoPagePdf());
  original.getPage(0).setRotation(degrees(90));
  original.getPage(0).setCropBox(10, 20, 500, 650);
  const a = source('a', await original.save());
  const b = source('b', await pdfWithText('MERGED END'));
  const snapshots = [a.bytes.slice(), b.bytes.slice()];
  const output = await assemblePdf(
    [a, b],
    [
      page('a-two', 'a', 1),
      page('b-one', 'b', 0, -90),
      page('a-copy', 'a', 0, 90),
      page('a-one', 'a'),
    ],
  );
  const doc = await PDFDocument.load(output);
  assert.equal(doc.getPageCount(), 4);
  assert.deepEqual(
    doc.getPages().map((p) => p.getRotation().angle),
    [0, 270, 180, 90],
  );
  assert.deepEqual(doc.getPage(2).getCropBox(), { x: 10, y: 20, width: 500, height: 650 });
  assert.deepEqual(doc.getPage(3).getMediaBox(), { x: 0, y: 0, width: 612, height: 792 });
  assert.deepEqual(await textOf(output), [
    'Terra PDF page two',
    'MERGED END',
    'Terra PDF page one',
    'Terra PDF page one',
  ]);
  assert.deepEqual(a.bytes, snapshots[0]);
  assert.deepEqual(b.bytes, snapshots[1]);
});

test('image pages retain aspect ratio, embed original resolution and bound physical page size', async () => {
  const png = source(
    'png',
    await sharp({ create: { width: 240, height: 180, channels: 4, background: '#f008' } })
      .png()
      .toBuffer(),
    'png',
  );
  const wide = source(
    'wide',
    await sharp({ create: { width: 3000, height: 1500, channels: 3, background: '#27a' } })
      .png()
      .toBuffer(),
    'png',
  );
  const jpg = source(
    'jpeg',
    await sharp({ create: { width: 180, height: 240, channels: 3, background: '#2a7' } })
      .jpeg()
      .toBuffer(),
    'jpg',
  );
  // Byte-offset inputs must not cause the JPEG parser to read unrelated prefix data.
  const wrapped = new Uint8Array(jpg.bytes.length + 11);
  wrapped.set(jpg.bytes, 7);
  jpg.bytes = wrapped.subarray(7, wrapped.length - 4);
  const sources = [png, wide, jpg];
  const snapshots = sources.map((s) => s.bytes.slice());
  for (const input of sources)
    assert.deepEqual(await inspectPdfSource(input), { pageCount: 1, hasForms: false });
  const output = await assemblePdf(sources, [
    page('p', 'png'),
    page('w', 'wide'),
    page('j', 'jpeg', 0, 90),
  ]);
  const doc = await PDFDocument.load(output);
  assert.deepEqual(
    doc.getPages().map((p) => p.getSize()),
    [
      { width: 240, height: 180 },
      { width: 1440, height: 720 },
      { width: 180, height: 240 },
    ],
  );
  assert.equal(doc.getPage(2).getRotation().angle, 90);
  const images = doc.getPages().map((p) => {
    const objects = p.node.Resources().lookup(PDFName.of('XObject'));
    return objects.entries().map(([, ref]) => {
      const object = doc.context.lookup(ref);
      return [
        object.dict.get(PDFName.of('Width')).asNumber(),
        object.dict.get(PDFName.of('Height')).asNumber(),
      ];
    });
  });
  assert.deepEqual(images, [[[240, 180]], [[3000, 1500]], [[180, 240]]]);
  sources.forEach((s, i) => assert.deepEqual(s.bytes, snapshots[i]));
});

test('PDF and image pages are interleaved in the requested order', async () => {
  const pdf = source('reference', twoPagePdf());
  const image = source(
    'image',
    await sharp({ create: { width: 80, height: 40, channels: 3, background: '#357' } })
      .jpeg()
      .toBuffer(),
    'jpg',
  );
  const bytes = await assemblePdf(
    [image, pdf],
    [page('first', 'reference', 1), page('image', 'image'), page('last', 'reference')],
  );
  const result = await PDFDocument.load(bytes);
  assert.deepEqual(await textOf(bytes), ['Terra PDF page two', '', 'Terra PDF page one']);
  assert.deepEqual(
    result.getPages().map((p) => p.getSize()),
    [
      { width: 612, height: 792 },
      { width: 80, height: 40 },
      { width: 612, height: 792 },
    ],
  );
});

test('form flattening retains existing visible appearance rather than regenerating field values', async () => {
  const doc = await PDFDocument.create();
  const p = doc.addPage([400, 500]);
  const field = doc.getForm().createTextField('answer');
  field.setText('VISIBLE APPEARANCE');
  field.addToPage(p, { x: 20, y: 300, width: 320, height: 40 });
  doc.getForm().updateFieldAppearances();
  field.setText('DO NOT REGENERATE');
  const input = source('filled', await doc.save({ updateFieldAppearances: false }));
  const original = input.bytes.slice();
  assert.deepEqual(await inspectPdfSource(input), { pageCount: 1, hasForms: true });
  const bytes = await assemblePdf([input], [page('form', 'filled')]);
  const output = await PDFDocument.load(bytes);
  assert.equal(output.getForm().getFields().length, 0);
  assert.equal(output.getPage(0).node.Annots()?.size() || 0, 0);
  assert.match((await textOf(bytes))[0], /VISIBLE APPEARANCE/);
  assert.doesNotMatch((await textOf(bytes))[0], /DO NOT REGENERATE/);
  assert.deepEqual(input.bytes, original);
});

test('empty results and empty or damaged source files fail with actionable errors', async () => {
  const valid = source('valid', twoPagePdf());
  await assert.rejects(assemblePdf([valid], []), /at least one page|empty/i);
  await assert.rejects(assemblePdf([], [page('missing', 'valid')]), /source|file/i);
  await assert.rejects(inspectPdfSource(source('empty', new Uint8Array())), /empty/i);
  await assert.rejects(
    inspectPdfSource(source('damaged', Buffer.from('%PDF-1.7\nNo pages'))),
    /damaged|read|valid PDF/i,
  );
  const zero = await PDFDocument.create();
  await assert.rejects(
    inspectPdfSource(source('zero', await zero.save({ addDefaultPage: false }))),
    /no pages|empty/i,
  );
  await assert.rejects(
    inspectPdfSource(source('wrong-png', Buffer.from('not an image'), 'png')),
    /PNG|image|damaged/i,
  );
  await assert.rejects(
    inspectPdfSource(source('wrong-jpg', Buffer.from('not an image'), 'jpg')),
    /JPEG|image|damaged/i,
  );
});

test('encryption and unsupported dynamic XFA forms cannot produce a silently damaged result', async () => {
  const encrypted = await PDFDocument.load(twoPagePdf());
  encrypted.context.trailerInfo.Encrypt = encrypted.context.register(
    encrypted.context.obj({ Filter: 'Standard', V: 2, R: 3 }),
  );
  const locked = source('locked', await encrypted.save());
  await assert.rejects(inspectPdfSource(locked), /password|encrypted|unlocked/i);
  await assert.rejects(
    assemblePdf([locked], [page('locked-page', 'locked')]),
    /password|encrypted|unlocked/i,
  );
  const xfa = await PDFDocument.load(twoPagePdf());
  xfa.getForm();
  xfa.catalog.AcroForm().set(PDFName.of('XFA'), PDFString.of('<xfa/>'));
  const dynamic = source('dynamic', await xfa.save({ updateFieldAppearances: false }));
  await assert.rejects(inspectPdfSource(dynamic), /XFA|dynamic form/i);
});

test('invalid source references, page indexes, identities and rotation values are rejected', async () => {
  const input = source('a', twoPagePdf());
  for (const spec of [
    page('x', 'missing'),
    page('x', 'a', -1),
    page('x', 'a', 2),
    page('x', 'a', 0.5),
  ])
    await assert.rejects(assemblePdf([input], [spec]), /source|page/i);
  for (const rotation of [45, NaN, Infinity, 90.5])
    await assert.rejects(assemblePdf([input], [page('x', 'a', 0, rotation)]), /rotation|90/i);
  await assert.rejects(assemblePdf([input, input], [page('x', 'a')]), /unique|duplicate/i);
  await assert.rejects(assemblePdf([input], [page('x', 'a'), page('x', 'a')]), /unique|duplicate/i);
});

test('byte limits apply to aggregate sources before parsing or copying large inputs', async () => {
  await assert.rejects(
    inspectPdfSource(source('huge', new Uint8Array(MAX_PDF_WORKSPACE_BYTES + 1))),
    /64 M[i]?B|size|memory/i,
  );
  const half = new Uint8Array(MAX_PDF_WORKSPACE_BYTES / 2 + 1);
  const a = { id: 'a', name: 'a.pdf', kind: 'pdf', bytes: half };
  const b = { id: 'b', name: 'b.pdf', kind: 'pdf', bytes: half };
  await assert.rejects(assemblePdf([a, b], [page('a', 'a')]), /64 M[i]?B|size|memory/i);
  assert.equal(half.byteLength, MAX_PDF_WORKSPACE_BYTES / 2 + 1);
});

test('page limits cover input PDFs and duplicate output pages without rejecting the boundary', async () => {
  const big = await PDFDocument.create();
  for (let i = 0; i <= MAX_PDF_PAGES; i++) big.addPage([10, 10]);
  const input = source('too-many', await big.save());
  await assert.rejects(inspectPdfSource(input), /500|page limit|too many pages/i);
  const one = source('one', await pdfWithText('Single page'));
  const pages = Array.from({ length: MAX_PDF_PAGES }, (_, i) => page(`p-${i}`, 'one'));
  await assert.rejects(
    assemblePdf([one], [...pages, page('one-more', 'one')]),
    /500|page limit|too many pages/i,
  );
  assert.equal((await PDFDocument.load(await assemblePdf([one], pages))).getPageCount(), 500);
});

test('absurd image dimensions are rejected before the image decoder allocates pixels', async () => {
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  png.writeUInt32BE(100000, 16);
  png.writeUInt32BE(100000, 20);
  await assert.rejects(
    inspectPdfSource(source('giant', png, 'png')),
    /pixels|dimensions|too large/i,
  );
});

// This adapter runs the real worker module and real structured-clone transfers in
// Node. Only the browser's Worker/event API is adapted; PDF operations are real.
async function withWorkers(run, startupError = false) {
  const previous = globalThis.Worker;
  const workers = [];
  class BrowserWorker {
    constructor(url) {
      this.terminated = false;
      workers.push(this);
      const bootstrap = startupError
        ? 'throw Error("worker startup failed")'
        : `
        import { parentPort } from 'node:worker_threads';
        globalThis.self = { postMessage: (data, transfer) => parentPort.postMessage(data, transfer) };
        await import(${JSON.stringify(url.href)});
        parentPort.on('message', data => self.onmessage({ data }));
      `;
      this.thread = new NodeWorker(
        new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),
      );
      this.thread.on('message', (data) => this.onmessage?.({ data }));
      this.thread.on('error', (error) =>
        this.onerror?.({ error, message: error.message, preventDefault() {} }),
      );
      this.thread.on('messageerror', (error) => this.onmessageerror?.({ error }));
    }
    postMessage(data, transfer) {
      this.thread.postMessage(data, transfer);
    }
    terminate() {
      this.terminated = true;
      this.stopped = this.thread.terminate();
    }
  }
  globalThis.Worker = BrowserWorker;
  try {
    await run(workers);
  } finally {
    globalThis.Worker = previous;
    for (const worker of workers) if (!worker.terminated) worker.terminate();
    await Promise.all(workers.map((worker) => worker.stopped));
  }
}

test('worker APIs return real PDF results, retain caller buffers and dispose completed workers', async () => {
  await withWorkers(async (workers) => {
    const input = { id: 'a', name: 'a.pdf', kind: 'pdf', bytes: twoPagePdf() };
    const before = Uint8Array.from(input.bytes);
    assert.deepEqual(await inspectPdfSourceLocal(input), { pageCount: 2, hasForms: false });
    const result = await assemblePdfLocal([input], [page('second', 'a', 1, 90)]);
    assert.deepEqual(await textOf(result), ['Terra PDF page two']);
    assert.equal((await PDFDocument.load(result)).getPage(0).getRotation().angle, 90);
    assert.deepEqual(Uint8Array.from(input.bytes), before);
    assert.equal(workers.length, 2);
    assert.ok(workers.every((worker) => worker.terminated));
  });
});

test('aborting PDF work stops its worker and pre-aborted work allocates no worker', async () => {
  await withWorkers(async (workers) => {
    const input = source('a', twoPagePdf());
    const before = input.bytes.slice();
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(inspectPdfSourceLocal(input, pre.signal), { name: 'AbortError' });
    assert.equal(workers.length, 0);
    const controller = new AbortController();
    const task = assemblePdfLocal([input], [page('a', 'a')], controller.signal);
    controller.abort();
    await assert.rejects(task, { name: 'AbortError' });
    assert.equal(workers.length, 1);
    assert.equal(workers[0].terminated, true);
    assert.deepEqual(input.bytes, before);
  });
});

test('worker failures reject with friendly errors and release the worker', async () => {
  await withWorkers(async (workers) => {
    await assert.rejects(
      inspectPdfSourceLocal(source('bad', Buffer.from('%PDF-1.7\nbroken'))),
      /damaged|read|valid/i,
    );
    assert.equal(workers.length, 1);
    assert.equal(workers[0].terminated, true);
  });
  await withWorkers(async (workers) => {
    await assert.rejects(
      inspectPdfSourceLocal(source('a', twoPagePdf())),
      /worker|PDF.*stopped|PDF.*failed/i,
    );
    assert.equal(workers.length, 1);
    assert.equal(workers[0].terminated, true);
  }, true);
});

test('a hung PDF worker is bounded by a timeout and terminated', async () => {
  await withWorkers(async (workers) => {
    const originalTimeout = globalThis.setTimeout;
    let boundedTimer = false;
    globalThis.setTimeout = (callback, delay, ...args) => {
      assert.ok(delay > 0 && delay <= 120000, 'operation timeout must be bounded');
      boundedTimer = true;
      return originalTimeout(callback, 1, ...args);
    };
    try {
      await assert.rejects(inspectPdfSourceLocal(source('a', twoPagePdf())), /timed out|too long/i);
      assert.equal(boundedTimer, true);
      assert.equal(workers[0].terminated, true);
    } finally {
      globalThis.setTimeout = originalTimeout;
    }
  });
});
