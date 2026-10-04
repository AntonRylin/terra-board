import type { CanvasObject, Asset } from '../model';
import { invoke, mediaUrl } from '../bridge';
import {
  documentKind,
  decodeDocumentText,
  MAX_PREVIEW_BYTES,
  MAX_TEXT_BYTES,
} from './document-files';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

export type DocumentPreview = Pick<
  CanvasObject,
  'documentPreviewId' | 'documentExcerpt' | 'documentPageCount'
>;

export async function documentBytes(
  o: CanvasObject,
  limit = MAX_PREVIEW_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!o.assetId) throw Error('The document file is missing.');
  const message = `Preview is limited to ${limit / 1024 / 1024} MB. You can still download this file.`;
  if ((o.documentBytes || 0) > limit) throw Error(message);
  const response = await fetch(mediaUrl(o.assetId, 'original'), { signal });
  if (!response.ok) throw Error('The document file could not be read.');
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw Error(message);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.length;
      if (length > limit) {
        await reader.cancel();
        throw Error(message);
      }
      chunks.push(result.value);
    }
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

export async function loadPdf(
  bytes: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<PDFDocumentProxy> {
  const pdfjs = await import('pdfjs-dist');
  signal?.throwIfAborted();
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const base = new URL('pdfjs/', window.location.href).href;
  const task = pdfjs.getDocument({
    data: bytes,
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
    wasmUrl: base + 'wasm/',
    maxImageSize: 64_000_000,
    useSystemFonts: true,
    stopAtErrors: true,
  });
  let password = false;
  task.onPassword = () => {
    password = true;
    void task.destroy();
  };
  const timeout = setTimeout(() => {
    void task.destroy();
  }, 30000);
  const abort = () => {
    void task.destroy();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    return await task.promise;
  } catch (error) {
    await task.destroy();
    if (password)
      throw Error('This PDF is password protected. Download it to open it in your PDF app.');
    throw Error('This PDF could not be previewed. You can still download the original file.', {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function paintPdfPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  width: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const natural = page.getViewport({ scale: 1 });
  const scale = Math.min(
    width / natural.width,
    Math.sqrt(4_000_000 / (natural.width * natural.height)),
  );
  const viewport = page.getViewport({ scale });
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const task = page.render({ canvas, viewport, background: '#ffffff' });
  const abort = () => task.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await task.promise;
  } catch (error) {
    canvas.width = canvas.height = 1;
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function docxParts(bytes: Uint8Array) {
  const { unzipSync } = await import('fflate');
  let expanded = 0,
    count = 0;
  const parts = unzipSync(bytes, {
    filter: (file) => {
      expanded += file.originalSize;
      if (++count > 4000 || expanded > 64 * 1024 * 1024 || file.originalSize > 32 * 1024 * 1024)
        throw Error('This Word document is too complex to preview. You can still download it.');
      return true;
    },
  });
  if (!parts['word/document.xml'])
    throw Error('This file does not contain a readable Word document.');
  return parts;
}

function xml(bytes: Uint8Array) {
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
  if (doc.querySelector('parsererror')) throw Error('The Word document contains damaged content.');
  return doc;
}

export async function docxExcerpt(bytes: Uint8Array) {
  const parts = await docxParts(bytes);
  const doc = xml(parts['word/document.xml']);
  return Array.from(doc.getElementsByTagNameNS('*', 'p'))
    .map((p) =>
      Array.from(p.getElementsByTagNameNS('*', 't'))
        .map((t) => t.textContent || '')
        .join(''),
    )
    .join('\n')
    .slice(0, 10000);
}

export async function docxHtml(bytes: Uint8Array): Promise<string> {
  const parts = await docxParts(bytes);
  const { zipSync, strToU8 } = await import('fflate');
  // Remove external relationships before the renderer creates any image or link.
  for (const [name, part] of Object.entries(parts)) {
    if (!name.endsWith('.rels')) continue;
    const doc = xml(part);
    for (const relationship of Array.from(doc.getElementsByTagNameNS('*', 'Relationship')))
      if (relationship.getAttribute('TargetMode')?.toLowerCase() === 'external')
        relationship.remove();
    parts[name] = strToU8(new XMLSerializer().serializeToString(doc));
  }
  const { renderAsync } = await import('docx-preview');
  const { default: DOMPurify } = await import('dompurify');
  const body = document.createElement('div'),
    styles = document.createElement('div');
  await renderAsync(zipSync(parts), body, styles, {
    renderAltChunks: false,
    useBase64URL: true,
    ignoreFonts: true,
    ignoreWidth: true,
    ignoreHeight: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
  });
  const clean = DOMPurify.sanitize(styles.innerHTML + body.innerHTML, {
    ADD_TAGS: ['style'],
    FORBID_TAGS: [
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'video',
      'audio',
      'link',
    ],
    FORBID_ATTR: ['href', 'xlink:href', 'target', 'srcset', 'action', 'formaction'],
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;background:#edf0f4;color:#1d2530;font-family:'Segoe UI',sans-serif}*{box-sizing:border-box}.docx-wrapper{padding:12px!important;background:transparent!important}.docx-wrapper>section.docx{width:100%!important;min-height:0!important;padding:24px!important;margin-bottom:12px!important;box-shadow:0 1px 5px #0001!important}img,svg{max-width:100%;height:auto}table{max-width:100%}p{overflow-wrap:anywhere}</style></head><body>${clean}</body></html>`;
}

// Imports run in the background, one bounded preview at a time. Failures never
// remove the attachment; opening the reader supplies the actionable error.
let previewTail = Promise.resolve();
export function prepareDocumentPreview(
  o: CanvasObject,
  signal?: AbortSignal,
): Promise<DocumentPreview> {
  const work = async (): Promise<DocumentPreview> => {
    if (signal?.aborted) return {};
    const kind = documentKind(o.text || '', o.documentMime);
    if (kind === 'file') return {};
    const bytes = await documentBytes(
      o,
      kind === 'text' ? MAX_TEXT_BYTES : MAX_PREVIEW_BYTES,
      signal,
    );
    if (kind === 'text') return { documentExcerpt: decodeDocumentText(bytes).text.slice(0, 10000) };
    if (kind === 'docx') return { documentExcerpt: await docxExcerpt(bytes) };
    const pdf = await loadPdf(bytes, signal);
    const canvas = document.createElement('canvas');
    try {
      const page = await pdf.getPage(1);
      await paintPdfPage(page, canvas, 1280, signal);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(Error('PDF preview could not be drawn.'))),
          'image/png',
        ),
      );
      signal?.throwIfAborted();
      const asset = await invoke<Asset>('importAsset', {
        name: 'Document preview.png',
        bytes: await blob.arrayBuffer(),
      });
      return { documentPreviewId: asset.id, documentPageCount: pdf.numPages };
    } finally {
      canvas.width = canvas.height = 1;
      await pdf.loadingTask.destroy();
    }
  };
  const task = previewTail.then(work);
  previewTail = task.then(
    () => {},
    () => {},
  );
  return task;
}
