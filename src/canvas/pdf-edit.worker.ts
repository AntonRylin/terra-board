import { assemblePdf, inspectPdfSource, type PdfSource, type PdfPageSpec } from './pdf-edit.ts';

export type PdfEditRequest =
  | { kind: 'inspect'; source: PdfSource }
  | { kind: 'assemble'; sources: PdfSource[]; pages: PdfPageSpec[] };

export type PdfEditResponse =
  | { ok: true; result: { pageCount: number; hasForms: boolean } | Uint8Array<ArrayBuffer> }
  | { ok: false; error: string };

// The app's TypeScript environment uses DOM globals; this module runs only in
// the disposable module worker, never in the renderer window.
const endpoint = self as unknown as {
  onmessage: ((event: MessageEvent<PdfEditRequest>) => void) | null;
  postMessage: (message: PdfEditResponse, transfer?: Transferable[]) => void;
};

endpoint.onmessage = async ({ data }) => {
  try {
    if (data?.kind === 'inspect') {
      endpoint.postMessage({ ok: true, result: await inspectPdfSource(data.source) });
    } else if (data?.kind === 'assemble') {
      const bytes = await assemblePdf(data.sources, data.pages);
      endpoint.postMessage({ ok: true, result: bytes }, [bytes.buffer]);
    } else {
      throw Error('This PDF editing operation is not supported.');
    }
  } catch (error) {
    endpoint.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'This file could not be processed as a PDF.',
    });
  }
};
