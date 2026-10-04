import { zip, type AsyncZippable } from 'fflate';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { PdfPageSpec } from './pdf-edit';

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;
type TextItem = Extract<TextContent['items'][number], { str: string }>;

const MAX_EDGE = 8192;
const MAX_CONVERSION_BYTES = 128 * 1024 * 1024;
const sizeError = () => Error('Converted files exceed 128 MB. Convert fewer pages at a time.');

// PDF page lookup, text extraction and native image encoding cannot themselves
// be interrupted. Stop awaiting them and ignore late responses after cancellation.
function cancellable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  cancel?: () => void,
): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      try {
        cancel?.();
      } finally {
        reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(signal.aborted ? signal.reason : error);
      },
    );
    if (signal.aborted) abort();
  });
}

function validatePage(pdf: PDFDocumentProxy, spec: PdfPageSpec) {
  if (!Number.isInteger(spec.pageIndex) || spec.pageIndex < 0 || spec.pageIndex >= pdf.numPages)
    throw Error('A selected PDF page is no longer available.');
  if (!Number.isFinite(spec.rotation) || spec.rotation % 90 !== 0)
    throw Error('PDF page rotation must be a multiple of 90 degrees.');
}

async function paintPage(
  page: PDFPageProxy,
  spec: PdfPageSpec,
  canvas: HTMLCanvasElement,
  requestedWidth: number | undefined,
  signal: AbortSignal | undefined,
  maxPixels: number,
) {
  signal?.throwIfAborted();
  const rotation = ((((page.rotate || 0) + spec.rotation) % 360) + 360) % 360;
  const natural = page.getViewport({ scale: 1, rotation });
  if (
    !Number.isFinite(natural.width) ||
    !Number.isFinite(natural.height) ||
    natural.width <= 0 ||
    natural.height <= 0
  )
    throw Error('This PDF page has invalid dimensions.');
  const width = requestedWidth ?? natural.width * 2;
  if (!Number.isFinite(width) || width <= 0) throw Error('PDF render width must be positive.');
  if (!Number.isFinite(maxPixels) || maxPixels < 1)
    throw Error('PDF render pixel limit must be positive.');
  const pixels = Math.floor(maxPixels);
  let scale = Math.min(
    width / natural.width,
    MAX_EDGE / natural.width,
    MAX_EDGE / natural.height,
    Math.sqrt(pixels / natural.width / natural.height),
  );
  let pixelWidth = Math.max(1, Math.floor(natural.width * scale));
  let pixelHeight = Math.max(1, Math.floor(natural.height * scale));
  // Rounding the narrow axis up to one pixel must not violate the pixel budget.
  if (pixelWidth * pixelHeight > pixels) {
    if (pixelWidth >= pixelHeight) pixelWidth = Math.max(1, Math.floor(pixels / pixelHeight));
    else pixelHeight = Math.max(1, Math.floor(pixels / pixelWidth));
  }
  scale = Math.min(pixelWidth / natural.width, pixelHeight / natural.height);
  const viewport = page.getViewport({ scale, rotation });
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const context = canvas.getContext('2d');
  if (!context) throw Error('The PDF page drawing surface could not be created.');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, pixelWidth, pixelHeight);
  signal?.throwIfAborted();
  const task = page.render({ canvas, viewport, background: '#ffffff' });
  await cancellable(task.promise, signal, () => task.cancel());
  signal?.throwIfAborted();
}

export async function renderPdfSheet(
  pdf: PDFDocumentProxy,
  spec: PdfPageSpec,
  canvas: HTMLCanvasElement,
  width: number,
  signal?: AbortSignal,
  maxPixels = 6_000_000,
): Promise<void> {
  try {
    signal?.throwIfAborted();
    if (!Number.isFinite(width) || width <= 0) throw Error('PDF render width must be positive.');
    validatePage(pdf, spec);
    const page = await cancellable(pdf.getPage(spec.pageIndex + 1), signal);
    signal?.throwIfAborted();
    await paintPage(page, spec, canvas, width, signal, maxPixels);
  } catch (error) {
    canvas.width = canvas.height = 1;
    throw error;
  }
}

function baseName(name: string) {
  return (
    (name.split(/[\\/]/).pop() || '')
      .replace(/\.[^.]+$/, '')
      .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 180) || 'document'
  );
}

function textFromPage(content: TextContent) {
  const parts: string[] = [];
  let previous: TextItem | undefined;
  let atLineStart = true;
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const value = item.str
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    if (value && previous && !atLineStart) {
      const [a, b, , , x, y] = previous.transform;
      const [, , , , nextX, nextY] = item.transform;
      const baseline = Math.hypot(a, b) || 1;
      const dx = nextX - x,
        dy = nextY - y;
      const height = Math.max(
        1,
        Math.min(Math.abs(previous.height) || baseline, Math.abs(item.height) || baseline),
      );
      const perpendicular = Math.abs((-b * dx + a * dy) / baseline);
      const gap = (a * dx + b * dy) / baseline - previous.width;
      if (perpendicular > Math.max(2, height * 0.5)) parts.push('\n');
      else if (
        gap > Math.max(0.5, height * 0.12) &&
        !/\s$/.test(parts.at(-1) || '') &&
        !/^\s/.test(value)
      )
        parts.push(' ');
    }
    if (value) {
      parts.push(value);
      atLineStart = value.endsWith('\n');
      previous = item;
    }
    if (item.hasEOL) {
      if (!atLineStart) parts.push('\n');
      atLineStart = true;
      previous = undefined;
    }
  }
  return parts.join('').trim();
}

async function encodedPage(
  canvas: HTMLCanvasElement,
  format: 'png' | 'jpg',
  remaining: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const blob = await cancellable(
    new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => {
          if (!value || value.type !== mime)
            reject(Error('The PDF page could not be encoded as an image.'));
          else resolve(value);
        },
        mime,
        0.92,
      );
    }),
    signal,
  );
  signal?.throwIfAborted();
  if (blob.size > remaining) throw sizeError();
  const bytes = new Uint8Array(await cancellable(blob.arrayBuffer(), signal));
  signal?.throwIfAborted();
  if (bytes.byteLength > remaining) throw sizeError();
  return bytes;
}

async function archivePages(files: AsyncZippable, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let terminate: (() => void) | undefined;
  const pending = new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    // PNG and JPEG are already compressed; store their exact encoded bytes.
    terminate = zip(files, { level: 0, consume: false }, (error, bytes) => {
      if (error) reject(error);
      else resolve(bytes);
    });
  });
  const bytes = await cancellable(pending, signal, () => terminate?.());
  signal?.throwIfAborted();
  if (bytes.byteLength > MAX_CONVERSION_BYTES) throw sizeError();
  return bytes;
}

export async function convertPdfPages(
  sources: Map<string, PDFDocumentProxy>,
  pages: PdfPageSpec[],
  format: 'png' | 'jpg' | 'txt',
  name: string,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<{ name: string; bytes: Uint8Array<ArrayBuffer> }> {
  signal?.throwIfAborted();
  if (!['png', 'jpg', 'txt'].includes(format))
    throw Error('Choose PNG, JPG or TXT for PDF conversion.');
  if (!pages.length) throw Error('Select at least one PDF page to convert.');
  if (pages.length > 500) throw Error('Convert at most 500 PDF pages at a time.');
  const order = pages.map((spec) => {
    const pdf = sources.get(spec.sourceId);
    if (!pdf) throw Error('A source PDF is missing. Open it again before converting.');
    validatePage(pdf, spec);
    return { pdf, spec: { ...spec } };
  });
  const base = baseName(name),
    files: AsyncZippable = {},
    chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0,
    hasText = false;
  onProgress?.(0, order.length);
  for (let index = 0; index < order.length; index++) {
    signal?.throwIfAborted();
    const { pdf, spec } = order[index];
    const page = await cancellable(pdf.getPage(spec.pageIndex + 1), signal);
    signal?.throwIfAborted();
    if (format === 'txt') {
      const content = await cancellable(
        page.getTextContent({ includeMarkedContent: false }),
        signal,
      );
      signal?.throwIfAborted();
      const text = textFromPage(content);
      hasText ||= !!text.trim();
      const bytes = new TextEncoder().encode((index ? '\n\f\n' : '') + text);
      length += bytes.byteLength;
      if (length > MAX_CONVERSION_BYTES) throw sizeError();
      chunks.push(bytes);
    } else {
      const canvas = document.createElement('canvas');
      try {
        // An unspecified target width renders the rotated natural page at 144dpi.
        await paintPage(page, spec, canvas, undefined, signal, 16_000_000);
        const bytes = await encodedPage(canvas, format, MAX_CONVERSION_BYTES - length, signal);
        length += bytes.byteLength;
        if (order.length === 1) chunks.push(bytes);
        else files[`page-${String(index + 1).padStart(3, '0')}.${format}`] = bytes;
      } finally {
        canvas.width = canvas.height = 1;
      }
    }
    signal?.throwIfAborted();
    onProgress?.(index + 1, order.length);
  }
  signal?.throwIfAborted();
  if (format === 'txt') {
    if (!hasText)
      throw Error(
        'This PDF has no selectable text. Scanned pages need OCR before they can be exported as text.',
      );
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { name: `${base}.txt`, bytes };
  }
  if (order.length === 1) return { name: `${base}-page.${format}`, bytes: chunks[0] };
  return { name: `${base}-pages.zip`, bytes: await archivePages(files, signal) };
}
