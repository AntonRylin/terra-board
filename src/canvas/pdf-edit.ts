import { PDFDocument, PDFName, degrees, type PDFPage } from 'pdf-lib';

export interface PdfSource {
  id: string;
  name: string;
  kind: 'pdf' | 'png' | 'jpg';
  bytes: Uint8Array<ArrayBuffer>;
}
export interface PdfPageSpec {
  id: string;
  sourceId: string;
  pageIndex: number;
  rotation: number;
}
export const MAX_PDF_WORKSPACE_BYTES = 64 * 1024 * 1024;
export const MAX_PDF_PAGES = 500;

const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_DECODE_BYTES = 128 * 1024 * 1024;
const MAX_IMAGE_EDGE = 32768;
const MAX_IMAGE_PAGE_EDGE = 1440;

class PdfEditError extends Error {}

function label(source: PdfSource) {
  return source.name?.slice(0, 160) || 'This file';
}

// Used before worker buffers are cloned as well as inside the worker.
export function validatePdfSources(sources: PdfSource[]) {
  if (!Array.isArray(sources) || !sources.length)
    throw new PdfEditError('Add at least one PDF or image source file.');
  let bytes = 0;
  const ids = new Set<string>();
  for (const source of sources) {
    if (!source || typeof source.id !== 'string' || !source.id || ids.has(source.id))
      throw new PdfEditError(
        'Every source file needs a unique ID; duplicate sources are not allowed.',
      );
    ids.add(source.id);
    if (typeof source.name !== 'string' || !['pdf', 'png', 'jpg'].includes(source.kind))
      throw new PdfEditError('Only PDF, PNG and JPEG source files can be assembled.');
    if (!(source.bytes instanceof Uint8Array) || !source.bytes.byteLength)
      throw new PdfEditError(`${label(source)} is empty. Choose a file with content.`);
    bytes += source.bytes.byteLength;
    if (bytes > MAX_PDF_WORKSPACE_BYTES)
      throw new PdfEditError(
        'PDF editing is limited to 64 MB of source files in total. Use fewer or smaller files.',
      );
  }
}

function failure(error: unknown, source?: PdfSource): Error {
  if (error instanceof PdfEditError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/encrypt|password/i.test(message))
    return new PdfEditError(
      `${source ? label(source) : 'This PDF'} is password protected. Export an unlocked PDF copy before editing it.`,
    );
  if (
    error instanceof RangeError ||
    /out of memory|allocation|array buffer|heap limit/i.test(message)
  )
    return new PdfEditError(
      'This document is too complex or needs too much memory. Try fewer pages or smaller files.',
    );
  return new PdfEditError(
    source
      ? `${label(source)} could not be read. It may be damaged or use an unsupported ${source.kind === 'pdf' ? 'PDF' : 'image'} format.`
      : 'The PDF could not be assembled. Try fewer pages or export the source files as new PDFs.',
  );
}

function checkedPageCount(count: number, source: PdfSource) {
  if (!Number.isSafeInteger(count) || count < 1)
    throw new PdfEditError(`${label(source)} has no pages. Choose a PDF with at least one page.`);
  if (count > MAX_PDF_PAGES)
    throw new PdfEditError(
      `${label(source)} exceeds the 500-page editing limit. Split it into smaller PDFs first.`,
    );
  return count;
}

async function loadPdf(source: PdfSource) {
  try {
    const doc = await PDFDocument.load(source.bytes, {
      updateMetadata: false,
      throwOnInvalidObject: true,
    });
    checkedPageCount(doc.getPageCount(), source);
    // getForm() silently removes XFA in pdf-lib; reject it before that happens.
    if (doc.catalog.AcroForm()?.has(PDFName.of('XFA')))
      throw new PdfEditError(
        `${label(source)} contains dynamic XFA forms. Export a static PDF copy before editing it.`,
      );
    for (const page of doc.getPages()) {
      const boxes = [page.getMediaBox(), page.getCropBox()];
      if (
        boxes.some(
          (box) =>
            ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
            box.width <= 0 ||
            box.height <= 0,
        )
      )
        throw new PdfEditError(`${label(source)} contains damaged page dimensions.`);
      if (!Number.isSafeInteger(page.getRotation().angle) || page.getRotation().angle % 90)
        throw new PdfEditError(`${label(source)} contains an unsupported page rotation.`);
    }
    return doc;
  } catch (error) {
    throw failure(error, source);
  }
}

interface ImageSize {
  width: number;
  height: number;
  decodeBytes: number;
}

function imageSize(source: PdfSource): ImageSize {
  const bytes = source.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const damaged = () =>
    new PdfEditError(
      `${label(source)} is not a complete, supported ${source.kind === 'png' ? 'PNG' : 'JPEG'} image.`,
    );
  const size = (width: number, height: number, depth = 8) => {
    const pixels = width * height;
    if (
      !width ||
      !height ||
      width > MAX_IMAGE_EDGE ||
      height > MAX_IMAGE_EDGE ||
      pixels > MAX_IMAGE_PIXELS
    )
      throw new PdfEditError(
        `${label(source)} has image dimensions that are too large. Resize it to at most 40 million pixels before adding it.`,
      );
    const decodeBytes = pixels * (depth === 16 ? 8 : 4);
    if (decodeBytes > MAX_IMAGE_DECODE_BYTES)
      throw new PdfEditError(
        `${label(source)} needs too much image memory. Resize it before adding it.`,
      );
    return { width, height, decodeBytes };
  };
  if (source.kind === 'png') {
    if (
      bytes.length < 33 ||
      view.getUint32(0) !== 0x89504e47 ||
      view.getUint32(4) !== 0x0d0a1a0a ||
      view.getUint32(8) !== 13 ||
      view.getUint32(12) !== 0x49484452
    )
      throw damaged();
    const result = size(view.getUint32(16), view.getUint32(20), bytes[24]);
    let offset = 8,
      hasData = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset),
        type = view.getUint32(offset + 4);
      if (offset + 12 + length > bytes.length) throw damaged();
      if (type === 0x6163544c)
        throw new PdfEditError(
          `${label(source)} is an animated PNG. Export a still PNG or JPEG first.`,
        );
      if (type === 0x49444154) hasData = true;
      if (type === 0x49454e44) {
        if (!hasData || length) throw damaged();
        return result;
      }
      offset += length + 12;
    }
    throw damaged();
  }
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) throw damaged();
  let hasEnd = false;
  for (let i = bytes.length - 2; i >= 2; i--) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
      hasEnd = true;
      break;
    }
  }
  if (!hasEnd) throw damaged();
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 0xff) throw damaged();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 1 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) throw damaged();
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) throw damaged();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) throw damaged();
      return size(view.getUint16(offset + 5), view.getUint16(offset + 3));
    }
    offset += length;
  }
  throw damaged();
}

async function embedImage(doc: PDFDocument, source: PdfSource) {
  try {
    // pdf-lib's JPEG parser reads from buffer offset zero; normalize subarrays.
    const bytes = Uint8Array.from(source.bytes);
    return await (source.kind === 'png' ? doc.embedPng(bytes) : doc.embedJpg(bytes));
  } catch (error) {
    throw failure(error, source);
  }
}

async function resizeImage(source: PdfSource, size: ImageSize, scale: number): Promise<PdfSource> {
  const width = Math.max(1, Math.floor(size.width * scale));
  const height = Math.max(1, Math.floor(size.height * scale));
  const type = source.kind === 'png' ? 'image/png' : 'image/jpeg';
  let bitmap: ImageBitmap | undefined;
  let canvas: OffscreenCanvas | undefined;
  try {
    // Decode and resize one source at a time in the PDF worker. PNG encoding
    // retains transparency; JPEG sources use high quality photo compression.
    bitmap = await createImageBitmap(new Blob([source.bytes], { type }), {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
      imageOrientation: 'none',
    });
    canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw Error('Image canvas could not be created.');
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type, quality: 0.92 });
    return { ...source, bytes: new Uint8Array(await blob.arrayBuffer()) };
  } catch (error) {
    throw failure(error, source);
  } finally {
    bitmap?.close();
    if (canvas) canvas.width = canvas.height = 1;
  }
}

export async function inspectPdfSource(
  source: PdfSource,
): Promise<{ pageCount: number; hasForms: boolean }> {
  validatePdfSources([source]);
  if (source.kind === 'pdf') {
    const doc = await loadPdf(source);
    try {
      return { pageCount: doc.getPageCount(), hasForms: doc.getForm().getFields().length > 0 };
    } catch (error) {
      throw failure(error, source);
    }
  }
  imageSize(source);
  await embedImage(await PDFDocument.create(), source);
  return { pageCount: 1, hasForms: false };
}

export async function assemblePdf(
  sources: PdfSource[],
  pages: PdfPageSpec[],
): Promise<Uint8Array<ArrayBuffer>> {
  validatePdfSources(sources);
  if (!Array.isArray(pages) || !pages.length)
    throw new PdfEditError('Keep at least one page in the resulting PDF.');
  if (pages.length > MAX_PDF_PAGES)
    throw new PdfEditError(
      'A PDF workspace can contain at most 500 pages. Remove some pages first.',
    );
  const sourceIds = new Set(sources.map((source) => source.id));
  const ids = new Set<string>();
  const selected = new Map<string, { spec: PdfPageSpec; position: number }[]>();
  pages.forEach((spec, position) => {
    if (!spec || typeof spec.id !== 'string' || !spec.id || ids.has(spec.id))
      throw new PdfEditError('Every page needs a unique ID; duplicate page IDs are not allowed.');
    ids.add(spec.id);
    if (!sourceIds.has(spec.sourceId))
      throw new PdfEditError('A selected page is missing its source file. Add the file again.');
    if (!Number.isSafeInteger(spec.pageIndex) || spec.pageIndex < 0)
      throw new PdfEditError('A selected page has an invalid page index. Choose an existing page.');
    if (!Number.isSafeInteger(spec.rotation) || spec.rotation % 90)
      throw new PdfEditError('Page rotation must use whole 90-degree turns.');
    const entries = selected.get(spec.sourceId) || [];
    entries.push({ spec, position });
    selected.set(spec.sourceId, entries);
  });
  let decodeBytes = 0;
  const imageSizes = new Map<string, ImageSize>();
  for (const source of sources) {
    if (!selected.has(source.id) || source.kind === 'pdf') continue;
    const size = imageSize(source);
    imageSizes.set(source.id, size);
    decodeBytes += size.decodeBytes;
  }
  // Keep normal exports at original resolution. Oversized batches share a
  // reduced pixel budget, with headroom for decoding and PNG alpha masks.
  const imageScale =
    decodeBytes > MAX_IMAGE_DECODE_BYTES ? Math.sqrt(MAX_IMAGE_DECODE_BYTES / 2 / decodeBytes) : 1;
  try {
    const result = await PDFDocument.create();
    const outputPages: PDFPage[] = new Array(pages.length);
    for (const source of sources) {
      const entries = selected.get(source.id);
      if (!entries) continue;
      if (source.kind === 'pdf') {
        const doc = await loadPdf(source);
        for (const { spec } of entries) {
          if (spec.pageIndex >= doc.getPageCount())
            throw new PdfEditError(
              `${label(source)} has no page ${spec.pageIndex + 1}. Choose an existing page.`,
            );
        }
        try {
          const form = doc.getForm();
          if (form.getFields().length) {
            form.flatten();
            // pdf-lib 1.17 leaves references to deleted widgets in Annots.
            // Keep valid annotations, but do not copy those dangling references.
            for (const page of doc.getPages()) {
              const annotations = page.node.Annots();
              if (!annotations) continue;
              for (let i = annotations.size() - 1; i >= 0; i--)
                if (!doc.context.lookup(annotations.get(i))) annotations.remove(i);
            }
          }
        } catch (error) {
          throw new PdfEditError(
            `${label(source)} has form fields that cannot be preserved. Print or export a flattened PDF copy first.`,
          );
        }
        // One copier per source shares fonts/images between copied and duplicated pages.
        const copies = await result.copyPages(
          doc,
          entries.map(({ spec }) => spec.pageIndex),
        );
        entries.forEach(({ spec, position }, i) => {
          const copy = copies[i];
          copy.setRotation(
            degrees((((copy.getRotation().angle + (spec.rotation % 360)) % 360) + 360) % 360),
          );
          outputPages[position] = copy;
        });
      } else {
        if (entries.some(({ spec }) => spec.pageIndex !== 0))
          throw new PdfEditError(`${label(source)} contains one image page only.`);
        const size = imageSizes.get(source.id)!;
        const prepared = imageScale < 1 ? await resizeImage(source, size, imageScale) : source;
        const image = await embedImage(result, prepared);
        // Release decoded PNG buffers before processing the next source.
        await image.embed();
        const scale = Math.min(1, MAX_IMAGE_PAGE_EDGE / Math.max(size.width, size.height));
        for (const { spec, position } of entries) {
          const copy = result.addPage([size.width * scale, size.height * scale]);
          copy.drawImage(image, {
            x: 0,
            y: 0,
            width: size.width * scale,
            height: size.height * scale,
          });
          copy.setRotation(degrees(((spec.rotation % 360) + 360) % 360));
          result.removePage(result.getPageCount() - 1);
          outputPages[position] = copy;
        }
      }
    }
    for (const page of outputPages) result.addPage(page);
    const bytes = await result.save({ addDefaultPage: false, updateFieldAppearances: false });
    if (bytes.byteLength > MAX_PDF_WORKSPACE_BYTES)
      throw new PdfEditError('The resulting PDF exceeds 64 MB. Use fewer pages or smaller images.');
    return Uint8Array.from(bytes);
  } catch (error) {
    throw failure(error);
  }
}
