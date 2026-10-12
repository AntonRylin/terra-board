import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, degrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import sharp from 'sharp';
import { compressPdfPages } from '../src/canvas/pdf-size.ts';

test('size-controlled export fits measured bytes and preserves visible page proportions and count', async () => {
  const original = await PDFDocument.create();
  const image = await original.embedPng(
    await sharp(randomBytes(900 * 1200 * 3), {
      raw: { width: 900, height: 1200, channels: 3 },
    })
      .png()
      .toBuffer(),
  );
  const page = original.addPage([450, 600]);
  page.drawImage(image, { x: 0, y: 0, width: 450, height: 600 });
  page.setRotation(degrees(90));
  original.addPage([300, 400]).drawText('Second page stays present');
  const task = getDocument({ data: await original.save(), useSystemFonts: true });
  const pdf = await task.promise;
  const canvas = createCanvas(1, 1);
  try {
    const bytes = await compressPdfPages(pdf, 120000, canvas);
    assert.ok(bytes.length <= 120000, `actual PDF is ${bytes.length} bytes`);
    const output = await PDFDocument.load(bytes);
    assert.equal(output.getPageCount(), 2);
    assert.deepEqual(
      output.getPages().map((p) => p.getSize()),
      [
        { width: 600, height: 450 },
        { width: 300, height: 400 },
      ],
    );
    assert.equal(canvas.width, 1, 'canvas allocation is released');
  } finally {
    await task.destroy();
  }
});

test('compression rejects invalid targets and respects cancellation', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  const task = getDocument({ data: await doc.save() });
  const pdf = await task.promise;
  const canvas = createCanvas(1, 1);
  try {
    for (const limit of [NaN, Infinity, 0, -1])
      await assert.rejects(compressPdfPages(pdf, limit, canvas), /target|size/i);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(compressPdfPages(pdf, 100000, canvas, controller.signal), {
      name: 'AbortError',
    });
  } finally {
    await task.destroy();
  }
});
