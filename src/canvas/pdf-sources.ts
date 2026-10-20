// What a PDF edit takes and its limits, without pdf-lib, so the board can
// check sources before the worker (pdf-edit.ts) loads the library.
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

export class PdfEditError extends Error {}

export function sourceLabel(source: PdfSource) {
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
      throw new PdfEditError(`${sourceLabel(source)} is empty. Choose a file with content.`);
    bytes += source.bytes.byteLength;
    if (bytes > MAX_PDF_WORKSPACE_BYTES)
      throw new PdfEditError(
        'PDF editing is limited to 64 MB of source files in total. Use fewer or smaller files.',
      );
  }
}
