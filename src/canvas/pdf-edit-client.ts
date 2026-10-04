import { validatePdfSources, MAX_PDF_PAGES, type PdfSource, type PdfPageSpec } from './pdf-edit.ts';
import type { PdfEditRequest, PdfEditResponse } from './pdf-edit.worker.ts';

const PDF_WORKER_TIMEOUT = 60_000;

function cloneSource(source: PdfSource): PdfSource {
  try {
    return { ...source, bytes: Uint8Array.from(source.bytes) };
  } catch {
    throw Error('There is not enough memory to prepare these files. Use fewer or smaller files.');
  }
}

function runWorker<T>(request: PdfEditRequest, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker?.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(new DOMException('PDF editing was cancelled.', 'AbortError'));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      worker = new Worker(new URL('./pdf-edit.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<PdfEditResponse>) => {
        const message = event.data;
        if (message?.ok === false) {
          finish(
            Error(
              typeof message.error === 'string' ? message.error : 'The PDF could not be processed.',
            ),
          );
        } else if (message?.ok === true) {
          const value = message.result;
          const valid =
            request.kind === 'assemble'
              ? value instanceof Uint8Array && value.byteLength > 0
              : !(value instanceof Uint8Array) &&
                Number.isInteger(value?.pageCount) &&
                value.pageCount > 0 &&
                value.pageCount <= MAX_PDF_PAGES &&
                typeof value.hasForms === 'boolean';
          if (valid) finish(undefined, value as T);
          else
            finish(Error('The PDF worker returned an unreadable result. Try the operation again.'));
        } else {
          finish(Error('The PDF worker returned an unreadable result. Try the operation again.'));
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        finish(Error('The PDF worker stopped unexpectedly. Try fewer pages or smaller files.'));
      };
      worker.onmessageerror = () =>
        finish(Error('The PDF worker result could not be read. Try the operation again.'));
      timeout = setTimeout(
        () => finish(Error('PDF editing timed out. Try fewer pages or smaller files.')),
        PDF_WORKER_TIMEOUT,
      );
      const transfers =
        request.kind === 'inspect'
          ? [request.source.bytes.buffer]
          : request.sources.map((source) => source.bytes.buffer);
      worker.postMessage(request, transfers);
    } catch {
      finish(Error('The PDF worker could not start. Try again or use fewer files.'));
    }
  });
}

export async function inspectPdfSourceLocal(
  source: PdfSource,
  signal?: AbortSignal,
): Promise<{ pageCount: number; hasForms: boolean }> {
  signal?.throwIfAborted();
  validatePdfSources([source]);
  return runWorker({ kind: 'inspect', source: cloneSource(source) }, signal);
}

export async function assemblePdfLocal(
  sources: PdfSource[],
  pages: PdfPageSpec[],
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  validatePdfSources(sources);
  if (!Array.isArray(pages) || !pages.length)
    throw Error('Keep at least one page in the resulting PDF.');
  if (pages.length > MAX_PDF_PAGES) throw Error('A PDF workspace can contain at most 500 pages.');
  return runWorker(
    {
      kind: 'assemble',
      sources: sources.map(cloneSource),
      pages: pages.map((page) => ({ ...page })),
    },
    signal,
  );
}
