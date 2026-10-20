import type { Asset, CanvasObject } from '../model';
import { invoke, mediaUrl } from '../bridge';
import { documentKind } from './document-files';
import { documentBytes, loadPdf } from './document-preview';
import {
  MAX_PDF_PAGES,
  MAX_PDF_WORKSPACE_BYTES,
  type PdfPageSpec,
  type PdfSource,
} from './pdf-sources';
import { assemblePdfLocal, inspectPdfSourceLocal } from './pdf-edit-client';
import { renderPdfSheet } from './pdf-render';
import { imageKind, jpegOrientation, pageName, pageRotation } from './pdf-pages';

// PNG keeps text crisp; photo-heavy pages switch to JPEG beyond this size.
const PNG_PAGE_LIMIT = 1_500_000;

export interface PageImage {
  asset: Asset;
  // The page's size in PDF points, for laying it out on the board.
  width: number;
  height: number;
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob && blob.type === type
          ? resolve(blob)
          : reject(Error('A page could not be encoded as an image.')),
      type,
      quality,
    ),
  );
}

export async function renderPageImages(
  o: CanvasObject,
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
): Promise<PageImage[]> {
  const bytes = await documentBytes(o, MAX_PDF_WORKSPACE_BYTES, signal);
  signal.throwIfAborted();
  const pdf = await loadPdf(bytes, signal);
  const canvas = document.createElement('canvas');
  try {
    const total = pdf.numPages;
    if (total > MAX_PDF_PAGES) throw Error('Turn PDFs of up to 500 pages into images.');
    const pages: PageImage[] = [];
    progress(0, total);
    for (let index = 0; index < total; index++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(index + 1);
      const natural = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
      const spec = { id: String(index), sourceId: '', pageIndex: index, rotation: 0 };
      // Twice the PDF size: 144 dpi, sharp when zoomed in on the board.
      await renderPdfSheet(pdf, spec, canvas, natural.width * 2, signal, 16_000_000);
      let blob = await encode(canvas, 'image/png');
      let extension = 'png';
      if (blob.size > PNG_PAGE_LIMIT) {
        blob = await encode(canvas, 'image/jpeg', 0.9);
        extension = 'jpg';
      }
      signal.throwIfAborted();
      const asset = await invoke<Asset>('importAsset', {
        name: pageName(o.text || 'Document.pdf', index + 1, extension),
        bytes: new Uint8Array(await blob.arrayBuffer()),
      });
      pages.push({ asset, width: natural.width, height: natural.height });
      progress(index + 1, total);
    }
    return pages;
  } finally {
    canvas.width = canvas.height = 1;
    await pdf.loadingTask.destroy();
  }
}

async function fetchBytes(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw Error('A selected file could not be read. Restore it or add it again.');
  return new Uint8Array(await response.arrayBuffer());
}

// The visible part of a cropped image, as PNG.
async function croppedImage(o: CanvasObject, signal: AbortSignal) {
  const blob = new Blob([await fetchBytes(mediaUrl(o.assetId!, 'export'), signal)], {
    type: 'image/png',
  });
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  try {
    const crop = o.crop!;
    const sx = crop.x * bitmap.width,
      sy = crop.y * bitmap.height;
    canvas.width = Math.max(1, Math.round(crop.width * bitmap.width));
    canvas.height = Math.max(1, Math.round(crop.height * bitmap.height));
    canvas
      .getContext('2d')!
      .drawImage(bitmap, sx, sy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return new Uint8Array(await (await encode(canvas, 'image/png')).arrayBuffer());
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 1;
  }
}

async function imageSource(o: CanvasObject, id: string, signal: AbortSignal): Promise<PdfSource> {
  const name = o.text || o.imageTitle || 'Image.png';
  if (o.crop) return { id, name, kind: 'png', bytes: await croppedImage(o, signal) };
  // The original keeps its compression; anything else uses the upright PNG copy.
  const original = await fetchBytes(mediaUrl(o.assetId!, 'original'), signal);
  const kind = imageKind(original);
  if (kind === 'png' || (kind === 'jpg' && jpegOrientation(original) === 1))
    return { id, name, kind, bytes: original };
  return {
    id,
    name,
    kind: 'png',
    bytes: await fetchBytes(mediaUrl(o.assetId!, 'export'), signal),
  };
}

export function canMergeToPdf(objects: CanvasObject[]) {
  return (
    objects.length > 1 &&
    objects.some((o) => o.type === 'image') &&
    objects.every(
      (o) =>
        !!o.assetId &&
        !o.album &&
        (o.type === 'image' ||
          (o.type === 'document' && documentKind(o.text || '', o.documentMime) === 'pdf')),
    )
  );
}

// Merges images and PDFs, in the order given, into one PDF.
export async function mergeToPdf(objects: CanvasObject[], signal: AbortSignal) {
  const sources: PdfSource[] = [];
  const pages: PdfPageSpec[] = [];
  let total = 0;
  for (const [index, o] of objects.entries()) {
    signal.throwIfAborted();
    const id = `source-${index}`;
    const source =
      o.type === 'image'
        ? await imageSource(o, id, signal)
        : {
            id,
            name: o.text || 'Document.pdf',
            kind: 'pdf' as const,
            bytes: await documentBytes(o, MAX_PDF_WORKSPACE_BYTES - total, signal),
          };
    total += source.bytes.byteLength;
    if (total > MAX_PDF_WORKSPACE_BYTES)
      throw Error('Merging is limited to 64 MB of files. Select fewer or smaller files.');
    const count =
      source.kind === 'pdf' ? (await inspectPdfSourceLocal(source, signal)).pageCount : 1;
    for (let page = 0; page < count; page++)
      pages.push({
        id: `${id}-${page}`,
        sourceId: id,
        pageIndex: page,
        rotation: o.type === 'image' ? pageRotation(o.rotation) : 0,
      });
    if (pages.length > MAX_PDF_PAGES) throw Error('A merged PDF can have at most 500 pages.');
    sources.push(source);
  }
  const bytes = await assemblePdfLocal(sources, pages, signal);
  return { bytes, pageCount: pages.length };
}
