import type { PDFDocumentProxy } from 'pdfjs-dist';
import { characterCount, pdfRunsToText, type RecognizedText } from './recognized-text';
import { renderPdfSheet } from './pdf-render';

const cache = new Map<string, Promise<RecognizedText>>();
function remember(key: string, load: () => Promise<RecognizedText>) {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const task = load();
  cache.set(key, task);
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  task.catch(() => cache.get(key) === task && cache.delete(key));
  return task;
}

export const canRecognizeText = () => !!window.canvas?.recognizeImage;

export function imageAssetText(assetId: string): Promise<RecognizedText> {
  if (!window.canvas) return Promise.reject(Error('Text recognition needs the desktop app.'));
  return remember('asset:' + assetId, () =>
    window.canvas!.recognizeAsset(assetId).then((text) => ({ ...text, source: 'ocr' as const })),
  );
}

async function recognizePage(pdf: PDFDocumentProxy, pageIndex: number, rotation: number) {
  const canvas = document.createElement('canvas');
  try {
    await renderPdfSheet(
      pdf,
      { id: '', sourceId: '', pageIndex, rotation },
      canvas,
      2400,
      undefined,
      10_000_000,
    );
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(Error('This page could not be read.'))),
        'image/png',
      ),
    );
    const text = await window.canvas!.recognizeImage(new Uint8Array(await blob.arrayBuffer()));
    return { ...text, source: 'ocr' as const };
  } finally {
    canvas.width = canvas.height = 1;
  }
}

/**
 * Selectable text for one PDF page: the PDF's own text when it has any, otherwise
 * Windows text recognition on the rendered page (scans and photographed pages).
 */
export function pdfPageText(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  rotation = 0,
): Promise<RecognizedText> {
  const key = `pdf:${pdf.fingerprints[0]}:${pdf.numPages}:${pageIndex}:${rotation}`;
  return remember(key, async () => {
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({
      scale: 1,
      rotation: ((((page.rotate || 0) + rotation) % 360) + 360) % 360,
    });
    const content = await page.getTextContent({ includeMarkedContent: false });
    const text = pdfRunsToText(content.items, viewport, content.styles);
    if (characterCount(text) >= 8 || !canRecognizeText()) return text;
    const recognized = await recognizePage(pdf, pageIndex, rotation);
    return characterCount(recognized) ? recognized : text;
  });
}
