import type { CanvasObject } from '../model';
import {
  documentKind,
  decodeDocumentText,
  MAX_TEXT_BYTES,
  MAX_PREVIEW_BYTES,
} from './document-files';
import { documentBytes, docxHtml } from './document-preview';

const MAX_HTML_BYTES = 16 * 1024 * 1024;
const CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";
const PRINT_STYLE = `@page{size:A4;margin:16mm}html,body{margin:0!important;background:white!important;color:#161616;font-family:'Segoe UI','Arial',sans-serif;font-size:11pt;line-height:1.45}*{box-sizing:border-box}img,svg{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}p,pre,td,th{overflow-wrap:anywhere}pre{white-space:pre-wrap;font:inherit;tab-size:4;margin:0}.docx-wrapper{display:block!important;padding:0!important;background:white!important}.docx-wrapper>section.docx{width:100%!important;min-height:0!important;height:auto!important;max-width:none!important;padding:0!important;margin:0!important;box-shadow:none!important;break-after:page}.docx-wrapper>section.docx:last-child{break-after:auto}.docx-wrapper>section.docx>article{columns:auto!important}`;

function builtinKind(object: CanvasObject) {
  if (!object.assetId) return null;
  if (object.type === 'image') return 'image';
  if (object.type !== 'document') return null;
  // Converted documents deliberately retain their original filename.
  if (object.documentMime === 'application/pdf') return 'pdf';
  const ext = object.text?.split('.').pop()?.toLowerCase();
  if (
    ext === 'html' ||
    ext === 'htm' ||
    object.documentMime === 'text/html' ||
    object.documentMime === 'application/xhtml+xml'
  )
    return 'html';
  const kind = documentKind(object.text || '', object.documentMime);
  return kind === 'file' ? null : kind;
}

export function isBuiltinConvertible(object: CanvasObject): boolean {
  return builtinKind(object) !== null;
}

function escaped(text: string) {
  return text.replace(
    /[&<>"']/g,
    (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!,
  );
}

function printHtml(body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${PRINT_STYLE}</style></head><body>${body}</body></html>`;
}

async function sanitizedHtml(source: string) {
  const { default: DOMPurify } = await import('dompurify');
  return DOMPurify.sanitize(source, {
    ADD_TAGS: ['style'],
    FORBID_TAGS: [
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'textarea',
      'select',
      'video',
      'audio',
      'link',
      'meta',
      'base',
    ],
    FORBID_ATTR: ['href', 'xlink:href', 'target', 'srcset', 'action', 'formaction'],
  });
}

function pdfName(name: string) {
  return `${(name.split(/[\\/]/).pop() || 'Document').replace(/\.[^.]+$/, '') || 'Document'}.pdf`;
}

export async function convertComposerInputs(
  objects: CanvasObject[],
  signal?: AbortSignal,
): Promise<CanvasObject[]> {
  signal?.throwIfAborted();
  if (objects.length > 500) throw Error('A PDF composer can contain up to 500 source files.');
  const kinds = objects.map(builtinKind);
  if (kinds.some((kind) => kind === null))
    throw Error('This file type cannot be converted by the built-in PDF converter.');
  if (kinds.some((kind) => kind !== 'pdf' && kind !== 'image') && !window.canvas?.printDocument)
    throw Error('Document conversion is available in the Terra Board desktop app.');
  const result: CanvasObject[] = [];
  for (let index = 0; index < objects.length; index++) {
    signal?.throwIfAborted();
    const object = objects[index],
      kind = kinds[index];
    if (kind === 'pdf' || kind === 'image') {
      result.push(object);
      continue;
    }
    const bytes = await documentBytes(
      object,
      kind === 'docx' ? MAX_PREVIEW_BYTES : MAX_TEXT_BYTES,
      signal,
    );
    signal?.throwIfAborted();
    let html: string;
    if (kind === 'docx') {
      const rendered = await docxHtml(bytes);
      // The preview is already sanitized; append print overrides after its screen CSS.
      html = rendered.replace('</head>', `<style>${PRINT_STYLE}</style></head>`);
    } else {
      const text = decodeDocumentText(bytes).text;
      html = printHtml(kind === 'html' ? await sanitizedHtml(text) : `<pre>${escaped(text)}</pre>`);
    }
    signal?.throwIfAborted();
    if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES)
      throw Error('The rendered document is too large to convert. Use a smaller document.');
    const asset = await window.canvas!.printDocument({
      html,
      name: pdfName(object.text || 'Document'),
    });
    signal?.throwIfAborted();
    result.push({
      ...object,
      assetId: asset.id,
      documentMime: 'application/pdf',
      documentBytes: asset.bytes,
      documentPreviewId: undefined,
      documentPageCount: undefined,
      documentExcerpt: undefined,
    });
  }
  return result;
}
