// Offline fixtures for the packaged PDF workspace check. Distinct page sizes,
// vector text and colors let the harness verify output order without snapshots.
import {
  PDFArray,
  PDFDocument,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  degrees,
  rgb,
} from 'pdf-lib';
import sharp from 'sharp';
import { simpleDocx } from './document-fixtures.mjs';

const sourcePages = [
  { marker: 'WORKSPACE SOURCE ALPHA', width: 600, height: 800, color: [0.88, 0.16, 0.22] },
  { marker: 'WORKSPACE SOURCE BETA', width: 640, height: 820, color: [0.12, 0.31, 0.86] },
];
const mergePages = [
  { marker: 'WORKSPACE MERGE GAMMA', width: 700, height: 500, color: [0.13, 0.65, 0.27] },
  { marker: 'WORKSPACE MERGE DELTA', width: 420, height: 660, color: [0.1, 0.67, 0.74] },
];
const composerPages = [
  { marker: 'COMPOSER EPSILON', width: 500, height: 700, rotation: 90, color: [0.73, 0.21, 0.61] },
  { marker: 'COMPOSER ZETA', width: 360, height: 540, rotation: 180, color: [0.76, 0.49, 0.12] },
];
const externalPages = [
  { marker: 'COMPOSER ETA', width: 300, height: 600, rotation: 270, color: [0.31, 0.26, 0.65] },
];

async function vectorPdf(pages) {
  const document = await PDFDocument.create();
  document.setCreationDate(new Date('2020-01-01T00:00:00Z'));
  document.setModificationDate(new Date('2020-01-01T00:00:00Z'));
  document.setTitle('Terra PDF workspace fixture');
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const [index, fixture] of pages.entries()) {
    const page = document.addPage([fixture.width, fixture.height]);
    if (fixture.rotation) page.setRotation(degrees(fixture.rotation));
    page.drawRectangle({
      x: 32,
      y: fixture.height * 0.54,
      width: fixture.width - 64,
      height: fixture.height * 0.35,
      color: rgb(...fixture.color),
    });
    page.drawText(fixture.marker, {
      x: 34,
      y: fixture.height * 0.43,
      size: 17,
      font,
      color: rgb(0.05, 0.05, 0.05),
    });
    page.drawText(`Vector text on original page ${index + 1}`, {
      x: 34,
      y: fixture.height * 0.36,
      size: 12,
      font,
      color: rgb(0.05, 0.05, 0.05),
    });
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function detailedImage() {
  const width = 2560,
    height = 1600;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const border = x < 24 || x >= width - 24 || y < 24 || y >= height - 24;
      const colors = border
        ? [24, 41, 71]
        : y < 240
          ? [226, 234, 246]
          : x < width / 2
            ? ((x >> 1) + (y >> 1)) & 1
              ? [242, 242, 242]
              : [35, 48, 68]
            : y < 800
              ? x & 1
                ? [24, 94, 225]
                : [237, 93, 51]
              : y < 1200
                ? [28, 151, 127]
                : [240, 174, 53];
      pixels[offset] = colors[0];
      pixels[offset + 1] = colors[1];
      pixels[offset + 2] = colors[2];
    }
  }
  const input = { raw: { width, height, channels: 3 } };
  const [png, tiff] = await Promise.all([
    sharp(pixels, input).png().toBuffer(),
    sharp(pixels, input).tiff({ compression: 'lzw' }).toBuffer(),
  ]);
  return { width, height, png, tiff };
}

export async function pdfWorkspaceFixtures() {
  const detail = await detailedImage();
  return {
    source: {
      name: 'Workspace reference.v2.pdf',
      bytes: await vectorPdf(sourcePages),
      pages: sourcePages,
    },
    merge: { name: 'Merged reference.pdf', bytes: await vectorPdf(mergePages), pages: mergePages },
    png: {
      name: 'Landscape image.png',
      width: 240,
      height: 180,
      bytes: await sharp({
        create: { width: 240, height: 180, channels: 3, background: '#eb892b' },
      })
        .png()
        .toBuffer(),
    },
    jpg: {
      name: 'Portrait image.jpg',
      width: 180,
      height: 240,
      bytes: await sharp({
        create: { width: 180, height: 240, channels: 3, background: '#8740ca' },
      })
        .jpeg({ quality: 95 })
        .toBuffer(),
    },
    viewerPng: {
      name: 'Full resolution reference.png',
      width: detail.width,
      height: detail.height,
      bytes: detail.png,
    },
    viewerTiff: {
      name: 'Full resolution fallback.tiff',
      width: detail.width,
      height: detail.height,
      bytes: detail.tiff,
    },
    malformed: {
      name: 'Broken merge.pdf',
      bytes: Buffer.from('%PDF-1.7\nDeliberately malformed, with no catalog or pages.\n'),
    },
  };
}

export async function inspectPdfPages(bytes) {
  const document = await PDFDocument.load(bytes);
  return document.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((reference) => document.context.lookup(reference))
        : [contents];
    const decoded = streams
      .filter((stream) => stream instanceof PDFRawStream)
      .map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'))
      .join('\n');
    const marker =
      [...sourcePages, ...mergePages, ...composerPages, ...externalPages].find(
        (fixture) =>
          decoded
            .toUpperCase()
            .includes(Buffer.from(fixture.marker).toString('hex').toUpperCase()) ||
          decoded.includes(fixture.marker),
      )?.marker || null;
    return { ...page.getSize(), rotation: ((page.getRotation().angle % 360) + 360) % 360, marker };
  });
}

export async function pdfComposerFixtures(officeFixtures = []) {
  const { source, merge, png, jpg, malformed } = await pdfWorkspaceFixtures();
  return {
    source,
    merge,
    png,
    jpg,
    malformed,
    rotated: {
      name: 'Rotated reference.pdf',
      bytes: await vectorPdf(composerPages),
      pages: composerPages,
    },
    external: {
      name: 'External reference.pdf',
      bytes: await vectorPdf(externalPages),
      pages: externalPages,
    },
    unsupported: {
      name: 'Unsupported attachment.bin',
      bytes: Buffer.from([0, 255, 12, 31, 128, 0, 42]),
    },
    docx: {
      name: 'Composer notes.v2.docx',
      bytes: simpleDocx(),
      textMarkers: ['Terra DOCX fixture', 'Original formatting and downloadable bytes.'],
    },
    text: {
      name: 'Composer long notes.txt',
      bytes: Buffer.from(
        [
          'COMPOSER TEXT FIRST — café, 日本語, Україна',
          ...Array.from(
            { length: 180 },
            (_, index) =>
              `COMPOSER LINE ${String(index + 1).padStart(3, '0')} — Local documents keep their complete text.`,
          ),
          'COMPOSER TEXT LAST — all 180 lines are preserved.',
        ].join('\n'),
      ),
      textMarkers: ['COMPOSER TEXT FIRST', 'COMPOSER LINE 090', 'COMPOSER TEXT LAST'],
      multipage: true,
    },
    html: {
      name: 'Composer outline.html',
      bytes: Buffer.from(
        '<!doctype html><html><head><meta charset="utf-8"><title>Composer HTML</title></head><body><h1>COMPOSER HTML FIRST</h1><p>Offline formatted content — café.</p><p>COMPOSER HTML LAST</p></body></html>',
      ),
      textMarkers: ['COMPOSER HTML FIRST', 'COMPOSER HTML LAST'],
    },
    ...Object.fromEntries(officeFixtures.map((fixture, index) => [`office${index}`, fixture])),
  };
}
