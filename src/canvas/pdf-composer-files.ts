import { uid, type CanvasObject, type PdfComposer, type PdfComposerSource } from '../model';
import { mediaUrl } from '../bridge';
import { documentKind } from './document-files';
import { MAX_PDF_PAGES, MAX_PDF_WORKSPACE_BYTES, type PdfSource } from './pdf-sources';
import { inspectPdfSourceLocal, assemblePdfLocal } from './pdf-edit-client';
import { createPdfPreviewWorker, loadPdf } from './document-preview';
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist';
import { compressPdfPages } from './pdf-size';

const byteLimit = () =>
  Error('A PDF composer can use up to 64 MB of source files. Use fewer or smaller files.');
const aborted = (signal?: AbortSignal) =>
  signal?.reason || new DOMException('PDF operation cancelled.', 'AbortError');

async function sourceBytes(
  source: Pick<PdfComposerSource, 'assetId' | 'kind'>,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  if (!source.assetId) throw Error('A source file is missing.');
  if (limit <= 0) throw byteLimit();
  const response = await fetch(
    mediaUrl(source.assetId, source.kind === 'image' ? 'export' : 'original'),
    { signal },
  );
  signal?.throwIfAborted();
  if (!response.ok)
    throw Error('A source file could not be read. Restore it or add the file again.');
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw byteLimit();
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    signal?.throwIfAborted();
    if (bytes.length > limit) throw byteLimit();
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const result = await reader.read();
      signal?.throwIfAborted();
      if (result.done) break;
      length += result.value.length;
      if (length > limit) throw byteLimit();
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function input(source: PdfComposerSource, bytes: Uint8Array<ArrayBuffer>): PdfSource {
  return { id: source.id, name: source.name, kind: source.kind === 'image' ? 'png' : 'pdf', bytes };
}

export async function prepareComposerSources(
  objects: CanvasObject[],
  signal?: AbortSignal,
): Promise<PdfComposerSource[]> {
  signal?.throwIfAborted();
  if (!objects.length) throw Error('Add at least one PDF or image.');
  if (objects.length > MAX_PDF_PAGES) throw Error('A PDF composer can contain up to 500 pages.');
  const sources: PdfComposerSource[] = objects.map((object) => {
    const kind =
      object.type === 'image'
        ? 'image'
        : object.type === 'document' &&
            documentKind(object.text || '', object.documentMime) === 'pdf'
          ? 'pdf'
          : null;
    if (!kind) throw Error('Add PDF or image files to a PDF composer.');
    if (!object.assetId) throw Error('A source file is missing.');
    return {
      id: uid(),
      assetId: object.assetId,
      name: object.text || object.imageTitle || (kind === 'pdf' ? 'Document.pdf' : 'Image.png'),
      kind,
      pageCount: 1,
    };
  });
  let total = 0,
    pages = 0;
  for (const source of sources) {
    const bytes = await sourceBytes(source, MAX_PDF_WORKSPACE_BYTES - total, signal);
    total += bytes.length;
    const metadata = await inspectPdfSourceLocal(input(source, bytes), signal);
    signal?.throwIfAborted();
    source.pageCount = metadata.pageCount;
    pages += metadata.pageCount;
    if (pages > MAX_PDF_PAGES) throw Error('A PDF composer can contain up to 500 pages.');
  }
  return sources;
}

function outputName(name: string) {
  const base = (name.split(/[\\/]/).pop() || '')
    .replace(
      /\.(pdf|png|jpe?g|tiff?|webp|gif|bmp|avif|heic|heif|ico|docx?|docm|dotx?|rtf|odt|ott|txt|text|md|markdown|csv|tsv|log|json|xml|html?|xlsx?|xlsm|xlsb|ods|ots|pptx?|pptm|odp|odg)$/i,
      '',
    )
    .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 180);
  return `${base || 'Document'}.pdf`;
}

export async function exportComposerColumn(
  composer: PdfComposer,
  columnId: string,
  signal?: AbortSignal,
  targetBytes?: number,
  progress?: (message: string) => void,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; name: string; pageCount: number }> {
  signal?.throwIfAborted();
  if (
    targetBytes !== undefined &&
    (!Number.isFinite(targetBytes) || targetBytes < 100_000 || targetBytes > 50_000_000)
  )
    throw Error('Choose a PDF target size from 0.1 to 50 MB.');
  const column = composer.columns.find((candidate) => candidate.id === columnId);
  if (!column) throw Error('This PDF column is no longer available.');
  const pages = column.pages
    .map((page, index) => ({ ...page, row: page.row ?? index }))
    .sort((a, b) => a.row - b.row);
  const name = outputName(column.name);
  if (!pages.length) throw Error('Add at least one page before exporting this column.');
  if (pages.length > MAX_PDF_PAGES) throw Error('A PDF composer can export up to 500 pages.');
  const sources = new Map(composer.sources.map((source) => [source.id, { ...source }]));
  const needed = [...new Set(pages.map((page) => page.sourceId))].map((id) => {
    const source = sources.get(id);
    if (!source) throw Error('A page source is no longer available.');
    return source;
  });
  const loaded: PdfSource[] = [];
  let total = 0;
  for (const source of needed) {
    const bytes = await sourceBytes(source, MAX_PDF_WORKSPACE_BYTES - total, signal);
    total += bytes.length;
    loaded.push(input(source, bytes));
  }
  let bytes = await assemblePdfLocal(loaded, pages, signal);
  signal?.throwIfAborted();
  if (targetBytes !== undefined && bytes.length > targetBytes) {
    progress?.('Preparing pages for compression…');
    const pdf = await loadPdf(bytes.slice(), signal);
    try {
      bytes = await compressPdfPages(
        pdf,
        targetBytes,
        document.createElement('canvas'),
        signal,
        progress,
      );
    } finally {
      await pdf.loadingTask.destroy();
    }
  }
  signal?.throwIfAborted();
  return { bytes, name, pageCount: pages.length };
}

interface PreviewEntry {
  key: string;
  refs: number;
  bytes: number;
  closed: boolean;
  abort: AbortController;
  promise: Promise<PDFDocumentProxy>;
}
export interface ComposerPreviewLease {
  pdf: PDFDocumentProxy;
  release: () => void;
}

// Visible tiles lease PDFs; the last tile leaving view releases its source.
// All active sources share one PDF.js worker and a bounded, sequential load queue.
export class ComposerPreviewPool {
  private entries = new Map<string, PreviewEntry>();
  private cleanup = new Set<Promise<void>>();
  private lifetime = new AbortController();
  private worker?: Promise<PDFWorker>;
  private tail: Promise<unknown> = Promise.resolve();
  private bytes = 0;
  private closed = false;

  acquire(source: PdfComposerSource, signal?: AbortSignal): Promise<ComposerPreviewLease> {
    if (this.closed || signal?.aborted) return Promise.reject(aborted(signal));
    const key = `${source.kind}:${source.assetId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const item: PreviewEntry = {
        key,
        refs: 0,
        bytes: 0,
        closed: false,
        abort: new AbortController(),
        promise: null!,
      };
      item.promise = this.tail
        .catch(() => {})
        .then(async () => {
          const scope = item.abort.signal;
          scope.throwIfAborted();
          const bytes = await sourceBytes(source, MAX_PDF_WORKSPACE_BYTES - this.bytes, scope);
          scope.throwIfAborted();
          this.bytes += item.bytes = bytes.length;
          const data =
            source.kind === 'pdf'
              ? bytes
              : await assemblePdfLocal(
                  [input(source, bytes)],
                  [{ id: 'preview', sourceId: source.id, pageIndex: 0, rotation: 0 }],
                  scope,
                );
          scope.throwIfAborted();
          this.worker ||= createPdfPreviewWorker(this.lifetime.signal);
          const worker = await this.worker;
          scope.throwIfAborted();
          const pdf = await loadPdf(data, scope, worker);
          if (scope.aborted) {
            await pdf.loadingTask.destroy();
            throw aborted(scope);
          }
          return pdf;
        });
      this.tail = item.promise;
      // A tile can disappear before its queued load starts.
      void item.promise.catch(() => {});
      this.entries.set(key, item);
      entry = item;
    }
    const item = entry;
    item.refs++;
    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener('abort', cancel);
        if (--item.refs === 0) this.release(item);
      };
      const cancel = () => {
        release();
        reject(aborted(signal));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      item.promise.then(
        (pdf) => {
          if (released || signal?.aborted) {
            cancel();
            return;
          }
          resolve({ pdf, release });
        },
        (error) => {
          release();
          reject(error);
        },
      );
      if (signal?.aborted) cancel();
    });
  }

  private release(entry: PreviewEntry) {
    if (entry.closed) return;
    entry.closed = true;
    entry.abort.abort();
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    const task = entry.promise
      .then((pdf) => pdf.loadingTask.destroy())
      .catch(() => {})
      .finally(() => {
        this.bytes -= entry.bytes;
        this.cleanup.delete(task);
      });
    this.cleanup.add(task);
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    for (const entry of this.entries.values()) this.release(entry);
    await Promise.allSettled([...this.cleanup]);
    if (this.worker) await this.worker.then((worker) => worker.destroy()).catch(() => {});
  }
}
