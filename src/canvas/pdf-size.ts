import { PDFDocument } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';

/** Render only when the original exceeds the requested attachment size. */
export async function compressPdfPages(
  pdf: PDFDocumentProxy,
  targetBytes: number,
  canvas: HTMLCanvasElement,
  signal?: AbortSignal,
  progress?: (message: string) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isFinite(targetBytes) || targetBytes <= 0)
    throw Error('Choose a positive PDF target size.');
  let edge = 2200;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      signal?.throwIfAborted();
      const output = await PDFDocument.create();
      for (let index = 1; index <= pdf.numPages; index++) {
        signal?.throwIfAborted();
        progress?.(
          `Compressing page ${index} of ${pdf.numPages}${attempt ? ` · pass ${attempt + 1}` : ''}…`,
        );
        const page = await pdf.getPage(index);
        signal?.throwIfAborted();
        const natural = page.getViewport({ scale: 1 });
        const scale = Math.min(2, edge / Math.max(natural.width, natural.height));
        const viewport = page.getViewport({ scale });
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        if (!context) throw Error('The PDF drawing surface could not be created.');
        const render = page.render({ canvas, viewport, background: '#ffffff' });
        const abort = () => render.cancel();
        signal?.addEventListener('abort', abort, { once: true });
        try {
          signal?.throwIfAborted();
          await render.promise;
          signal?.throwIfAborted();
          const blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (value) =>
                value ? resolve(value) : reject(Error('This PDF page could not be compressed.')),
              'image/jpeg',
              Math.max(0.55, 0.86 - attempt * 0.07),
            ),
          );
          signal?.throwIfAborted();
          const image = await output.embedJpg(await blob.arrayBuffer());
          const copy = output.addPage([natural.width, natural.height]);
          copy.drawImage(image, { x: 0, y: 0, width: natural.width, height: natural.height });
          await image.embed();
        } finally {
          signal?.removeEventListener('abort', abort);
          page.cleanup();
          canvas.width = canvas.height = 1;
        }
      }
      signal?.throwIfAborted();
      const bytes = await output.save();
      if (bytes.length <= targetBytes) return Uint8Array.from(bytes);
      const next = Math.floor(edge * Math.min(0.85, Math.sqrt(targetBytes / bytes.length) * 0.9));
      if (edge <= 360) break;
      edge = Math.max(360, next);
    }
    throw Error(
      'This PDF cannot fit the chosen size without making pages too small. Choose a larger target.',
    );
  } finally {
    canvas.width = canvas.height = 1;
  }
}
